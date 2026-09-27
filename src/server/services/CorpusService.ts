// SPDX-License-Identifier: Apache-2.0
//
// Remote knowledge-corpus operations (MCAA-260, ADR 0001).
//
// This is where the ADR's blocking conditions live:
//   - member selection uses the `publishable` narrowing on a shared corpus, on
//     build AND rebuild, as one INSERT ... SELECT ... FOR SHARE;
//   - a stored artifact is servable only when its digest still matches live
//     membership, never because it is the newest;
//   - both ceilings are checked, with matches counted before `limit`;
//   - a corpus the caller may not see is 404, never 403.
//
// The route layer owns HTTP concerns; this owns the rules. Errors are thrown as
// `CorpusOperationError` carrying the contract's status and body.

import type { PostgresPool } from '../../storage/postgres/pool.js';
import { withPostgresTransaction } from '../../storage/postgres/pool.js';
import {
  PostgresCorpusRepository,
  type PostgresCorpus,
  type PostgresCorpusMember,
} from '../../storage/postgres/corpora.js';
import { PostgresProjectsRepository } from '../../storage/postgres/projects.js';
import { deterministicKey } from '../../storage/postgres/utils.js';
import { logger } from '../../utils/logger.js';
import {
  CORPUS_ERRORS,
  DEFAULT_CORPUS_MEMBER_LIMIT,
  MAX_ARTIFACTS_PER_CORPUS,
  MAX_CORPUS_MEMBERS,
  MAX_CORPUS_TOKENS,
  corpusContentDigest,
  isArtifactServable,
  type BuildCorpusRequest,
  type CorpusFilter,
  type CorpusScope,
  type CorpusSummary,
} from '../contracts/corpus-v1.js';
import { renderCorpus, summarizeMembers, type RenderedCorpus } from './corpus-render.js';
import type { CorpusAnswerer, CorpusAnswerTurn } from './CorpusAnswerer.js';

export interface CorpusCaller {
  teamId: string;
  /** Project the request addresses. Never taken from the client for the team. */
  projectId: string;
  /**
   * The API key's own project scope, when it has one. The id-addressed routes
   * have no `:projectId` to check `ensureProjectAllowed()` against, so they
   * carry the scope here instead of letting a project-scoped key read a sibling
   * project's corpus.
   */
  projectScope?: string | null;
}

export class CorpusOperationError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : String(body.error));
    this.name = 'CorpusOperationError';
    this.status = status;
    this.body = body;
  }
}

/**
 * A corpus the caller may not see is indistinguishable from one that does not
 * exist. Never 403 here (ADR condition 9) — a 403 confirms the name exists.
 */
function notFound(what: string): CorpusOperationError {
  return new CorpusOperationError(CORPUS_ERRORS.notFound.status, {
    error: CORPUS_ERRORS.notFound.error,
    message: `${what} not found`,
  });
}

function tooLarge(input: {
  reason: 'members' | 'tokens';
  matchedCount: number;
  tokenEstimate: number;
}): CorpusOperationError {
  return new CorpusOperationError(CORPUS_ERRORS.tooLarge.status, {
    error: CORPUS_ERRORS.tooLarge.error,
    message: input.reason === 'members'
      ? `This filter matches ${input.matchedCount} observations, above the ${MAX_CORPUS_MEMBERS} member ceiling. Narrow the filter.`
      : `This corpus renders to ~${input.tokenEstimate} tokens, above the ${MAX_CORPUS_TOKENS} token ceiling. Reduce the content volume.`,
    reason: input.reason,
    matchedCount: input.matchedCount,
    tokenEstimate: input.tokenEstimate,
    maxMembers: MAX_CORPUS_MEMBERS,
    maxTokens: MAX_CORPUS_TOKENS,
  });
}

/** The filter identity, so a rebuild with an unchanged filter is recognisable. */
export function corpusFilterDigest(filter: CorpusFilter): string {
  return `sha256:${deterministicKey([filter])}`;
}

export interface CorpusDetailView extends CorpusSummary {
  filter: CorpusFilter;
  sources?: Array<Record<string, unknown>>;
}

export interface CorpusServiceOptions {
  pool: PostgresPool;
  /** Null means this deployment cannot answer corpus questions. */
  answerer?: CorpusAnswerer | null;
}

export class CorpusService {
  private readonly repo: PostgresCorpusRepository;

  constructor(private readonly options: CorpusServiceOptions) {
    this.repo = new PostgresCorpusRepository(options.pool);
  }

  /**
   * Build or rebuild in place. One transaction: candidates are counted, the
   * member set is replaced by the atomic INSERT ... SELECT, and the render is
   * checked against the token ceiling before anything commits.
   */
  async build(caller: CorpusCaller, request: BuildCorpusRequest): Promise<{
    corpus: CorpusDetailView;
    created: boolean;
  }> {
    await this.assertProjectVisible(caller);
    const filter: CorpusFilter = request.filter ?? {};
    const breadth: CorpusScope = filter.scope ?? 'project';
    const shared = request.shared === true;
    const limit = filter.limit ?? DEFAULT_CORPUS_MEMBER_LIMIT;

    return withPostgresTransaction(this.options.pool, async (client) => {
      const repo = new PostgresCorpusRepository(client);
      const counts = await repo.countCandidates({
        projectId: caller.projectId,
        teamId: caller.teamId,
        filter,
        breadth,
        shared,
      });

      // D3: publishing over private rows is rejected, not filtered down and not
      // downgraded. Checked here on build and rebuild alike.
      if (shared && counts.privateMemberCount > 0) {
        throw new CorpusOperationError(CORPUS_ERRORS.sharedPrivateMembers.status, {
          error: CORPUS_ERRORS.sharedPrivateMembers.error,
          message: `${counts.privateMemberCount} matched observations are not shared. `
            + 'A shared corpus may only contain observations that are themselves shared.',
          privateMemberCount: counts.privateMemberCount,
        });
      }
      if (counts.matchedCount > MAX_CORPUS_MEMBERS) {
        throw tooLarge({ reason: 'members', matchedCount: counts.matchedCount, tokenEstimate: 0 });
      }

      const { corpus, created } = await repo.upsert({
        projectId: caller.projectId,
        teamId: caller.teamId,
        name: request.name,
        description: request.description ?? '',
        filter,
        filterDigest: corpusFilterDigest(filter),
        memberScope: breadth,
        shared,
      });
      // A rebuild changes membership, so every cached render is stale by
      // definition. Purge rather than rely on the digest check alone.
      await repo.deleteArtifacts(corpus.id);
      await repo.replaceMembers({
        corpusId: corpus.id,
        projectId: caller.projectId,
        teamId: caller.teamId,
        filter,
        breadth,
        shared,
        limit,
      });

      const members = await repo.listMembers({
        corpusId: corpus.id,
        readerProjectId: caller.projectId,
        readerTeamId: caller.teamId,
      });
      const rendered = renderCorpus({
        name: corpus.name,
        description: corpus.description,
        filter,
        members,
      });
      if (rendered.tokenEstimate > MAX_CORPUS_TOKENS) {
        throw tooLarge({
          reason: 'tokens',
          matchedCount: counts.matchedCount,
          tokenEstimate: rendered.tokenEstimate,
        });
      }

      const stats = {
        ...summarizeMembers(members),
        matchedCount: counts.matchedCount,
        truncated: counts.matchedCount > limit,
        tokenEstimate: rendered.tokenEstimate,
      };
      const stored = await repo.setStats(corpus.id, stats);
      return {
        created,
        corpus: this.toDetail(stored ?? corpus, {
          teamId: caller.teamId,
          members,
          primedAtEpoch: null,
          contentDigest: null,
          statsOverride: stats,
        }),
      };
    });
  }

  async rebuild(caller: CorpusCaller, name: string): Promise<CorpusDetailView> {
    const existing = await this.requireOwnCorpus(caller, name);
    const request: BuildCorpusRequest = {
      name: existing.name,
      description: existing.description,
      filter: existing.filter,
      shared: existing.shared,
    };
    const result = await this.build(caller, request);
    return result.corpus;
  }

  async list(caller: CorpusCaller, input: { scope: CorpusScope; limit: number }): Promise<CorpusSummary[]> {
    const rows = await this.repo.list({
      projectId: caller.projectId,
      teamId: caller.teamId,
      scope: input.scope,
      limit: input.limit,
    });
    // Listing reports each corpus's stored build-time stats rather than
    // resolving every member set; `get_corpus` is the read that recomputes
    // observationCount from live membership.
    const summaries: CorpusSummary[] = [];
    for (const row of rows) {
      summaries.push(this.toSummary(row, {
        teamId: caller.teamId,
        primedAtEpoch: await this.repo.latestPrimedAt(row.id),
        contentDigest: null,
      }));
    }
    return summaries;
  }

  async getByName(caller: CorpusCaller, name: string, options: { includeSources: boolean }): Promise<CorpusDetailView> {
    const corpus = await this.requireOwnCorpus(caller, name);
    return this.detailFor(caller, corpus, options);
  }

  async getById(caller: CorpusCaller, corpusId: string, options: { includeSources: boolean }): Promise<CorpusDetailView> {
    const corpus = await this.requireVisibleCorpus(caller, corpusId);
    return this.detailFor(caller, corpus, options);
  }

  /**
   * Materialise the render. Deterministic, so priming an unchanged corpus finds
   * the same digest and writes nothing new.
   */
  async prime(caller: CorpusCaller, input: { name: string; force?: boolean }): Promise<{
    corpus: CorpusSummary;
    artifactId: string;
    contentDigest: string;
    tokenEstimate: number;
    alreadyPrimed: boolean;
  }> {
    const corpus = await this.requireOwnCorpus(caller, input.name);
    if (input.force) {
      await this.repo.deleteArtifacts(corpus.id);
    }
    const members = await this.loadMembers(caller, corpus);
    const contentDigest = corpusContentDigest(members.map(toIdentity));
    const existing = input.force ? null : await this.repo.getArtifact({ corpusId: corpus.id, contentDigest });
    if (existing) {
      return {
        corpus: this.toSummary(corpus, {
          teamId: caller.teamId,
          members,
          primedAtEpoch: existing.primedAtEpoch,
          contentDigest,
        }),
        artifactId: existing.id,
        contentDigest,
        tokenEstimate: existing.tokenEstimate,
        alreadyPrimed: true,
      };
    }
    const rendered = renderCorpus({
      name: corpus.name,
      description: corpus.description,
      filter: corpus.filter,
      members,
    });
    const artifact = await this.persistArtifact(corpus.id, contentDigest, rendered);
    return {
      corpus: this.toSummary(corpus, {
        teamId: caller.teamId,
        members,
        primedAtEpoch: artifact?.primedAtEpoch ?? null,
        contentDigest,
      }),
      artifactId: artifact?.id ?? ephemeralArtifactId(contentDigest),
      contentDigest,
      tokenEstimate: rendered.tokenEstimate,
      alreadyPrimed: false,
    };
  }

  /**
   * Ask a question. The digest is recomputed from live membership on every
   * request and a stored artifact is served only when it matches — serving the
   * newest artifact by `primed_at` would keep answering from deleted or
   * un-shared rows (ADR D2 rule 1).
   */
  async query(caller: CorpusCaller, input: {
    name?: string;
    corpusId?: string;
    question: string;
    history: readonly CorpusAnswerTurn[];
  }): Promise<{ answer: string; name: string; artifactId: string; contentDigest: string }> {
    const answerer = this.options.answerer;
    if (!answerer) {
      throw new CorpusOperationError(CORPUS_ERRORS.internal.status, {
        error: CORPUS_ERRORS.internal.error,
        message: 'This server has no knowledge provider configured, so it cannot answer corpus questions. '
          + 'Set CLAUDE_MEM_SERVER_PROVIDER and the matching API key.',
      });
    }
    const corpus = input.name !== undefined
      ? await this.requireOwnCorpus(caller, input.name)
      : await this.requireVisibleCorpus(caller, input.corpusId ?? '');
    const members = await this.loadMembers(caller, corpus);
    const contentDigest = corpusContentDigest(members.map(toIdentity));

    const stored = await this.repo.getArtifact({ corpusId: corpus.id, contentDigest });
    let artifactId = stored?.id ?? ephemeralArtifactId(contentDigest);
    let systemPrompt = stored?.systemPrompt ?? '';
    let renderedText = stored?.rendered ?? '';
    if (!stored || !isArtifactServable(stored.contentDigest, members.map(toIdentity))) {
      // Prime is optional: render for this request and persist best-effort, so
      // a read-only key never meets a "not primed" error.
      const rendered = renderCorpus({
        name: corpus.name,
        description: corpus.description,
        filter: corpus.filter,
        members,
      });
      systemPrompt = rendered.systemPrompt;
      renderedText = rendered.rendered;
      const persisted = await this.persistArtifact(corpus.id, contentDigest, rendered);
      artifactId = persisted?.id ?? ephemeralArtifactId(contentDigest);
    }

    const answer = await answerer.answer({
      systemPrompt,
      rendered: renderedText,
      question: input.question,
      history: input.history,
    });
    return { answer, name: corpus.name, artifactId, contentDigest };
  }

  /** Cache invalidation: drop every render, then materialise the current one. */
  async reprime(caller: CorpusCaller, name: string): Promise<{
    corpus: CorpusSummary;
    artifactId: string;
    contentDigest: string;
    tokenEstimate: number;
    alreadyPrimed: boolean;
  }> {
    return this.prime(caller, { name, force: true });
  }

  async delete(caller: CorpusCaller, name: string): Promise<void> {
    const deleted = await this.repo.deleteByName({
      projectId: caller.projectId,
      teamId: caller.teamId,
      name,
    });
    if (!deleted) throw notFound(`Corpus "${name}"`);
  }

  private async detailFor(
    caller: CorpusCaller,
    corpus: PostgresCorpus,
    options: { includeSources: boolean },
  ): Promise<CorpusDetailView> {
    const members = await this.loadMembers(caller, corpus);
    return this.toDetail(corpus, {
      teamId: caller.teamId,
      members,
      primedAtEpoch: await this.repo.latestPrimedAt(corpus.id),
      contentDigest: corpusContentDigest(members.map(toIdentity)),
      ...(options.includeSources ? { sources: members.map(serializeSource) } : {}),
    });
  }

  /**
   * Members as this caller may see them now. A foreign shared corpus resolves
   * only its shared rows, which is safe by the D3 invariant: they are the same
   * rows POST /v1/search { scope: 'shared' } would already return.
   */
  private loadMembers(caller: CorpusCaller, corpus: PostgresCorpus): Promise<PostgresCorpusMember[]> {
    return this.repo.listMembers({
      corpusId: corpus.id,
      readerProjectId: corpus.projectId,
      readerTeamId: caller.teamId,
    });
  }

  private async persistArtifact(
    corpusId: string,
    contentDigest: string,
    rendered: RenderedCorpus,
  ): Promise<{ id: string; primedAtEpoch: number } | null> {
    try {
      const artifact = await this.repo.upsertArtifact({
        corpusId,
        contentDigest,
        systemPrompt: rendered.systemPrompt,
        rendered: rendered.rendered,
        tokenEstimate: rendered.tokenEstimate,
      });
      await this.repo.pruneArtifacts(corpusId, MAX_ARTIFACTS_PER_CORPUS);
      return { id: artifact.id, primedAtEpoch: artifact.primedAtEpoch };
    } catch (error) {
      // Caching is an optimisation; failing to cache must not fail the answer.
      logger.warn('SYSTEM', 'corpus artifact persist failed; serving an unpersisted render', {
        corpusId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async requireOwnCorpus(caller: CorpusCaller, name: string): Promise<PostgresCorpus> {
    const corpus = await this.repo.getByName({
      projectId: caller.projectId,
      teamId: caller.teamId,
      name,
    });
    if (!corpus) throw notFound(`Corpus "${name}"`);
    return corpus;
  }

  private async requireVisibleCorpus(caller: CorpusCaller, corpusId: string): Promise<PostgresCorpus> {
    const corpus = corpusId
      ? await this.repo.getByIdVisible({ corpusId, teamId: caller.teamId })
      : null;
    if (!corpus) throw notFound('Corpus');
    // A project-scoped key sees its own project and published corpora, nothing
    // else in its team. 404 rather than 403 so the id is not confirmed.
    const scope = caller.projectScope;
    if (scope && corpus.projectId !== scope && !corpus.shared) throw notFound('Corpus');
    return corpus;
  }

  private async assertProjectVisible(caller: CorpusCaller): Promise<void> {
    const project = await new PostgresProjectsRepository(this.options.pool)
      .getByIdForTeam(caller.projectId, caller.teamId);
    if (!project) throw notFound(`Project "${caller.projectId}"`);
  }

  private toSummary(corpus: PostgresCorpus, context: {
    teamId: string;
    members?: readonly PostgresCorpusMember[];
    primedAtEpoch: number | null;
    contentDigest: string | null;
    statsOverride?: Record<string, unknown>;
  }): CorpusSummary {
    const storedStats = corpus.stats as Record<string, unknown>;
    const live = context.members ? summarizeMembers(context.members) : null;
    const stats = context.statsOverride ?? {
      // observationCount comes from live membership where we have it, because a
      // deleted or un-shared observation must make the count fall (ADR D2).
      observationCount: live?.observationCount ?? numberOr(storedStats.observationCount, 0),
      matchedCount: numberOr(storedStats.matchedCount, live?.observationCount ?? 0),
      truncated: storedStats.truncated === true,
      tokenEstimate: numberOr(storedStats.tokenEstimate, 0),
      kindBreakdown: live?.kindBreakdown ?? recordOr(storedStats.kindBreakdown),
      earliestAtEpoch: live ? live.earliestAtEpoch : nullableNumber(storedStats.earliestAtEpoch),
      latestAtEpoch: live ? live.latestAtEpoch : nullableNumber(storedStats.latestAtEpoch),
    };
    return {
      id: corpus.id,
      projectId: corpus.projectId,
      name: corpus.name,
      description: corpus.description,
      shared: corpus.shared,
      memberScope: corpus.memberScope,
      foreign: corpus.teamId !== context.teamId,
      stats: stats as CorpusSummary['stats'],
      filterDigest: corpus.filterDigest,
      contentDigest: context.contentDigest,
      session_id: null,
      builtAtEpoch: corpus.builtAtEpoch,
      primedAtEpoch: context.primedAtEpoch,
      createdAtEpoch: corpus.createdAtEpoch,
      updatedAtEpoch: corpus.updatedAtEpoch,
    };
  }

  private toDetail(corpus: PostgresCorpus, context: {
    teamId: string;
    members?: readonly PostgresCorpusMember[];
    primedAtEpoch: number | null;
    contentDigest: string | null;
    statsOverride?: Record<string, unknown>;
    sources?: Array<Record<string, unknown>>;
  }): CorpusDetailView {
    return {
      ...this.toSummary(corpus, context),
      filter: corpus.filter,
      ...(context.sources ? { sources: context.sources } : {}),
    };
  }
}

function toIdentity(member: PostgresCorpusMember): { id: string; updatedAtEpoch: number; shared: boolean } {
  return { id: member.id, updatedAtEpoch: member.updatedAtEpoch, shared: member.shared };
}

function serializeSource(member: PostgresCorpusMember, index: number): Record<string, unknown> {
  return {
    id: member.id,
    projectId: member.projectId,
    kind: member.kind,
    content: member.content,
    metadata: member.metadata,
    shared: member.shared,
    position: index,
    createdAtEpoch: member.createdAtEpoch,
  };
}

/**
 * Returned when the best-effort artifact write failed. It is deliberately not a
 * row id: the client learns the answer came from an uncached render rather than
 * being handed an id that resolves to nothing.
 */
function ephemeralArtifactId(contentDigest: string): string {
  return `ephemeral:${contentDigest}`;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordOr(value: unknown): Record<string, number> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, number>;
  }
  return {};
}
