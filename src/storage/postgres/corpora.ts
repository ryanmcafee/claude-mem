// SPDX-License-Identifier: Apache-2.0
//
// Postgres storage for remote knowledge corpora (MCAA-260, ADR 0001).
//
// Membership is stored by reference: this module never writes observation
// content into `corpora` or `corpus_members` (ADR condition 2). The one
// by-value copy is `corpus_artifacts`, and it is only ever served when its
// content digest still matches live membership.

import type { CorpusFilter, CorpusScope } from '../../server/contracts/corpus-v1.js';
import { CORPUS_MEMBER_ORDER, CorpusFilterSchema } from '../../server/contracts/corpus-v1.js';
import type { JsonObject, PostgresQueryable } from './utils.js';
import { newId, queryOne, toEpoch, toJsonObject } from './utils.js';

export interface PostgresCorpus {
  id: string;
  projectId: string;
  teamId: string;
  name: string;
  description: string;
  filter: CorpusFilter;
  filterDigest: string;
  memberScope: CorpusScope;
  shared: boolean;
  stats: JsonObject;
  builtAtEpoch: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

/** One member row as the digest sees it: identity only, never content. */
export interface PostgresCorpusMemberIdentity {
  id: string;
  updatedAtEpoch: number;
  shared: boolean;
}

/** One member row as the renderer sees it. */
export interface PostgresCorpusMember extends PostgresCorpusMemberIdentity {
  projectId: string;
  kind: string;
  content: string;
  metadata: JsonObject;
  createdAtEpoch: number;
}

export interface PostgresCorpusArtifact {
  id: string;
  corpusId: string;
  contentDigest: string;
  systemPrompt: string;
  rendered: string;
  tokenEstimate: number;
  primedAtEpoch: number;
}

export interface CorpusCandidateCounts {
  /** Rows the filter matched BEFORE `limit` — the number the ceilings test. */
  matchedCount: number;
  /**
   * Matched rows a shared corpus may not contain. Non-zero means the caller
   * asked to publish over private observations and the build must be rejected.
   */
  privateMemberCount: number;
}

interface CorpusRow {
  id: string;
  project_id: string;
  team_id: string;
  name: string;
  description: string;
  filter: unknown;
  filter_digest: string;
  member_scope: string;
  shared: boolean;
  stats: unknown;
  built_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MemberRow {
  id: string;
  project_id: string;
  kind: string;
  content: string;
  metadata: unknown;
  shared: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ArtifactRow {
  id: string;
  corpus_id: string;
  content_digest: string;
  system_prompt: string;
  rendered: string;
  token_estimate: number;
  primed_at: Date;
}

/**
 * Builds the SQL fragment for one filter field set, appending parameters to
 * `params`. Returned clauses are ANDed by the caller. Every field here has a
 * real `observations` column or is JSONB containment — the contract rejects the
 * rest at the edge rather than accepting and ignoring them.
 */
function buildFilterClauses(filter: CorpusFilter, params: unknown[]): string[] {
  const clauses: string[] = [];
  if (filter.kinds && filter.kinds.length > 0) {
    params.push(filter.kinds);
    clauses.push(`observations.kind = ANY($${params.length}::text[])`);
  }
  if (filter.query) {
    params.push(filter.query);
    clauses.push(`observations.content_search @@ websearch_to_tsquery('english', $${params.length})`);
  }
  if (filter.dateStartEpoch !== undefined) {
    params.push(new Date(filter.dateStartEpoch));
    clauses.push(`observations.created_at >= $${params.length}`);
  }
  if (filter.dateEndEpoch !== undefined) {
    params.push(new Date(filter.dateEndEpoch));
    clauses.push(`observations.created_at <= $${params.length}`);
  }
  if (filter.metadataMatch && Object.keys(filter.metadataMatch).length > 0) {
    params.push(JSON.stringify(filter.metadataMatch));
    clauses.push(`observations.metadata @> $${params.length}::jsonb`);
  }
  return clauses;
}

/**
 * The platform-source filter mirrors `PostgresObservationRepository.search()`:
 * an observation matches via its session, or via the agent event it was
 * generated from. Kept identical so a corpus and a search agree on what
 * "from Cursor" means.
 */
function platformSourceClause(params: unknown[], platformSource: string | null): string {
  params.push(platformSource);
  const index = params.length;
  return `(
    $${index}::text IS NULL
    OR EXISTS (
      SELECT 1 FROM server_sessions
      WHERE server_sessions.id = observations.server_session_id
        AND server_sessions.project_id = observations.project_id
        AND server_sessions.team_id = observations.team_id
        AND server_sessions.platform_source = $${index}
    )
    OR (
      observations.server_session_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM observation_sources
        INNER JOIN agent_events
          ON agent_events.id = observation_sources.agent_event_id
          AND agent_events.project_id = observations.project_id
          AND agent_events.team_id = observations.team_id
        WHERE observation_sources.observation_id = observations.id
          AND observation_sources.source_type = 'agent_event'
          AND agent_events.platform_source = $${index}
      )
    )
  )`;
}

/**
 * The candidate-row predicate. `breadth` is which rows the caller may see;
 * `publishable` is the narrowing conjunct a shared corpus adds (ADR D3). They
 * are deliberately separate arguments: `scope: 'shared'` WIDENS and admits the
 * caller's own private rows, so it must never be mistaken for the narrowing.
 */
function memberPredicate(
  params: unknown[],
  input: { projectId: string; teamId: string; breadth: CorpusScope; publishable: boolean },
): string {
  params.push(input.projectId);
  const projectIndex = params.length;
  params.push(input.teamId);
  const teamIndex = params.length;
  params.push(input.breadth === 'shared');
  const sharedIndex = params.length;
  const breadth = `((observations.project_id = $${projectIndex} AND observations.team_id = $${teamIndex})`
    + ` OR ($${sharedIndex} AND observations.shared))`;
  return input.publishable ? `(${breadth} AND observations.shared)` : breadth;
}

export class PostgresCorpusRepository {
  constructor(private client: PostgresQueryable) {}

  /**
   * Create or update the corpus row for `(team_id, project_id, name)`. Build
   * and rebuild both land here, so repeating either converges on one row
   * instead of duplicating.
   */
  async upsert(input: {
    projectId: string;
    teamId: string;
    name: string;
    description: string;
    filter: CorpusFilter;
    filterDigest: string;
    memberScope: CorpusScope;
    shared: boolean;
  }): Promise<{ corpus: PostgresCorpus; created: boolean }> {
    const existing = await this.getByName({
      projectId: input.projectId,
      teamId: input.teamId,
      name: input.name,
    });
    const row = await queryOne<CorpusRow>(
      this.client,
      `
        INSERT INTO corpora (
          id, project_id, team_id, name, description, filter, filter_digest,
          member_scope, shared, built_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
        ON CONFLICT (team_id, project_id, name) DO UPDATE SET
          description = excluded.description,
          filter = excluded.filter,
          filter_digest = excluded.filter_digest,
          member_scope = excluded.member_scope,
          shared = excluded.shared,
          built_at = now(),
          updated_at = now()
        RETURNING *
      `,
      [
        existing?.id ?? newId(),
        input.projectId,
        input.teamId,
        input.name,
        input.description,
        JSON.stringify(input.filter),
        input.filterDigest,
        input.memberScope,
        input.shared,
      ],
    );
    return { corpus: mapCorpusRow(row!), created: existing === null };
  }

  async setStats(corpusId: string, stats: JsonObject): Promise<PostgresCorpus | null> {
    const row = await queryOne<CorpusRow>(
      this.client,
      'UPDATE corpora SET stats = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *',
      [corpusId, JSON.stringify(stats)],
    );
    return row ? mapCorpusRow(row) : null;
  }

  /**
   * Replace the member set from the stored filter in ONE statement, so nothing
   * can interleave between deciding which rows qualify and inserting them
   * (ADR D3). `FOR SHARE` holds the observation rows for the transaction.
   *
   * The caller must run this inside a transaction; the delete and the insert
   * are not atomic with each other otherwise.
   */
  async replaceMembers(input: {
    corpusId: string;
    projectId: string;
    teamId: string;
    filter: CorpusFilter;
    breadth: CorpusScope;
    shared: boolean;
    limit: number;
  }): Promise<number> {
    await this.client.query('DELETE FROM corpus_members WHERE corpus_id = $1', [input.corpusId]);

    const params: unknown[] = [input.corpusId, input.projectId, input.teamId];
    const filterClauses = buildFilterClauses(input.filter, params);
    const predicate = memberPredicate(params, {
      projectId: input.projectId,
      teamId: input.teamId,
      breadth: input.breadth,
      publishable: input.shared,
    });
    const platform = platformSourceClause(params, input.filter.platformSource ?? null);
    params.push(input.limit);
    const limitIndex = params.length;
    const where = [predicate, platform, ...filterClauses].join(' AND ');

    // Selection keeps the NEWEST matches (CORPUS_LIMIT_SELECTION); render order
    // is applied separately at read time, oldest-first.
    const inserted = await this.client.query(
      `
        INSERT INTO corpus_members (corpus_id, project_id, team_id, observation_id)
        SELECT $1, $2, $3, selected.id
        FROM (
          SELECT observations.id
          FROM observations
          WHERE ${where}
          ORDER BY observations.created_at DESC, observations.id DESC
          LIMIT $${limitIndex}
          FOR SHARE OF observations
        ) AS selected
      `,
      params,
    );

    return inserted.rowCount ?? 0;
  }

  /**
   * Count matches BEFORE `limit` is applied, so the maxMembers ceiling can fire
   * at all, plus how many of them a shared corpus would have to exclude. Run
   * this before `replaceMembers` so a rejected build never destroys the member
   * set it was going to replace.
   */
  async countCandidates(input: {
    projectId: string;
    teamId: string;
    filter: CorpusFilter;
    breadth: CorpusScope;
    shared: boolean;
  }): Promise<CorpusCandidateCounts> {
    const params: unknown[] = [];
    const filterClauses = buildFilterClauses(input.filter, params);
    const breadth = memberPredicate(params, {
      projectId: input.projectId,
      teamId: input.teamId,
      breadth: input.breadth,
      publishable: false,
    });
    const platform = platformSourceClause(params, input.filter.platformSource ?? null);
    const where = [breadth, platform, ...filterClauses].join(' AND ');
    const result = await this.client.query<{ matched: string; private_members: string }>(
      `
        SELECT
          count(*) FILTER (WHERE $${params.length + 1}::boolean = false OR observations.shared) AS matched,
          count(*) FILTER (WHERE $${params.length + 1}::boolean AND NOT observations.shared) AS private_members
        FROM observations
        WHERE ${where}
      `,
      [...params, input.shared],
    );
    const row = result.rows[0];
    return {
      matchedCount: Number(row?.matched ?? 0),
      privateMemberCount: Number(row?.private_members ?? 0),
    };
  }

  /**
   * Members as the reader is entitled to see them RIGHT NOW. The join re-applies
   * the tenant predicate, so a deleted or un-shared observation disappears from
   * the corpus without any cache invalidation step (ADR D2).
   */
  async listMembers(input: {
    corpusId: string;
    readerProjectId: string;
    readerTeamId: string;
  }): Promise<PostgresCorpusMember[]> {
    const result = await this.client.query<MemberRow>(
      `
        SELECT observations.id, observations.project_id, observations.kind, observations.content,
               observations.metadata, observations.shared, observations.created_at, observations.updated_at
        FROM corpus_members
        INNER JOIN observations ON observations.id = corpus_members.observation_id
        WHERE corpus_members.corpus_id = $1
          AND ((observations.project_id = $2 AND observations.team_id = $3) OR observations.shared)
        ORDER BY ${CORPUS_MEMBER_ORDER}
      `,
      [input.corpusId, input.readerProjectId, input.readerTeamId],
    );
    return result.rows.map(mapMemberRow);
  }

  async getByName(input: {
    projectId: string;
    teamId: string;
    name: string;
  }): Promise<PostgresCorpus | null> {
    const row = await queryOne<CorpusRow>(
      this.client,
      'SELECT * FROM corpora WHERE team_id = $1 AND project_id = $2 AND name = $3',
      [input.teamId, input.projectId, input.name],
    );
    return row ? mapCorpusRow(row) : null;
  }

  /**
   * Id-addressed lookup for the read-only `/v1/corpora/:corpusId` routes. Own
   * tenant always; another tenant's row only when published. Anything else
   * returns null and the route answers 404, never 403 (ADR condition 9).
   */
  async getByIdVisible(input: { corpusId: string; teamId: string }): Promise<PostgresCorpus | null> {
    const row = await queryOne<CorpusRow>(
      this.client,
      'SELECT * FROM corpora WHERE id = $1 AND (team_id = $2 OR shared)',
      [input.corpusId, input.teamId],
    );
    return row ? mapCorpusRow(row) : null;
  }

  async list(input: {
    projectId: string;
    teamId: string;
    scope: CorpusScope;
    limit: number;
  }): Promise<PostgresCorpus[]> {
    const result = await this.client.query<CorpusRow>(
      `
        SELECT * FROM corpora
        WHERE ((project_id = $1 AND team_id = $2) OR ($4 AND shared))
        ORDER BY updated_at DESC
        LIMIT $3
      `,
      [input.projectId, input.teamId, input.limit, input.scope === 'shared'],
    );
    return result.rows.map(mapCorpusRow);
  }

  async deleteByName(input: { projectId: string; teamId: string; name: string }): Promise<boolean> {
    const result = await this.client.query(
      'DELETE FROM corpora WHERE team_id = $1 AND project_id = $2 AND name = $3',
      [input.teamId, input.projectId, input.name],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getArtifact(input: { corpusId: string; contentDigest: string }): Promise<PostgresCorpusArtifact | null> {
    const row = await queryOne<ArtifactRow>(
      this.client,
      'SELECT * FROM corpus_artifacts WHERE corpus_id = $1 AND content_digest = $2',
      [input.corpusId, input.contentDigest],
    );
    return row ? mapArtifactRow(row) : null;
  }

  async upsertArtifact(input: {
    corpusId: string;
    contentDigest: string;
    systemPrompt: string;
    rendered: string;
    tokenEstimate: number;
  }): Promise<PostgresCorpusArtifact> {
    const row = await queryOne<ArtifactRow>(
      this.client,
      `
        INSERT INTO corpus_artifacts (id, corpus_id, content_digest, system_prompt, rendered, token_estimate)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (corpus_id, content_digest) DO UPDATE SET
          system_prompt = excluded.system_prompt,
          rendered = excluded.rendered,
          token_estimate = excluded.token_estimate
        RETURNING *
      `,
      [newId(), input.corpusId, input.contentDigest, input.systemPrompt, input.rendered, input.tokenEstimate],
    );
    return mapArtifactRow(row!);
  }

  /** Drop every cached render for a corpus — reprime, and membership changes. */
  async deleteArtifacts(corpusId: string): Promise<number> {
    const result = await this.client.query('DELETE FROM corpus_artifacts WHERE corpus_id = $1', [corpusId]);
    return result.rowCount ?? 0;
  }

  /**
   * Keep the newest `keep` artifacts. Bounds how long a superseded render — and
   * therefore a since-deleted observation's text — can linger in the cache.
   */
  async pruneArtifacts(corpusId: string, keep: number): Promise<number> {
    const result = await this.client.query(
      `
        DELETE FROM corpus_artifacts
        WHERE corpus_id = $1
          AND id NOT IN (
            SELECT id FROM corpus_artifacts
            WHERE corpus_id = $1
            ORDER BY primed_at DESC, id DESC
            LIMIT $2
          )
      `,
      [corpusId, keep],
    );
    return result.rowCount ?? 0;
  }

  /** Newest render time across a corpus's artifacts, for `primedAtEpoch`. */
  async latestPrimedAt(corpusId: string): Promise<number | null> {
    const row = await queryOne<{ primed_at: Date }>(
      this.client,
      'SELECT primed_at FROM corpus_artifacts WHERE corpus_id = $1 ORDER BY primed_at DESC LIMIT 1',
      [corpusId],
    );
    return row ? toEpoch(row.primed_at) : null;
  }
}

/**
 * A stored filter only ever got there through the contract schema, so failing
 * to parse means the stored shape and the contract have diverged. Refuse the
 * corpus rather than falling back to an empty filter — on a rebuild an empty
 * filter matches everything, which is the opposite of what the operator asked
 * for.
 */
function parseStoredFilter(raw: unknown, name: string): CorpusFilter {
  const parsed = CorpusFilterSchema.safeParse(toJsonObject(raw));
  if (!parsed.success) {
    throw new Error(
      `Corpus "${name}" has a stored filter this server cannot read: `
      + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
}

function mapCorpusRow(row: CorpusRow): PostgresCorpus {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    filter: parseStoredFilter(row.filter, row.name),
    filterDigest: row.filter_digest,
    memberScope: row.member_scope === 'shared' ? 'shared' : 'project',
    shared: row.shared === true,
    stats: toJsonObject(row.stats),
    builtAtEpoch: row.built_at ? toEpoch(row.built_at) : null,
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at),
  };
}

function mapMemberRow(row: MemberRow): PostgresCorpusMember {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    content: row.content,
    metadata: toJsonObject(row.metadata),
    shared: row.shared === true,
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at),
  };
}

function mapArtifactRow(row: ArtifactRow): PostgresCorpusArtifact {
  return {
    id: row.id,
    corpusId: row.corpus_id,
    contentDigest: row.content_digest,
    systemPrompt: row.system_prompt,
    rendered: row.rendered,
    tokenEstimate: Number(row.token_estimate),
    primedAtEpoch: toEpoch(row.primed_at),
  };
}
