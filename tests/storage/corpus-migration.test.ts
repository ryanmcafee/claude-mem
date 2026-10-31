// SPDX-License-Identifier: Apache-2.0
//
// MCAA-260 — the corpus tables must be safe to roll forward AND back on someone
// else's cluster, unattended. This exercises the real DDL: bootstrap → verify →
// apply CORPUS_DOWN_SQL → verify gone → re-bootstrap → verify back, asserting
// that rolling back loses corpora (derived state) but never an observation.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  CORPUS_DOWN_SQL,
} from '../../src/storage/postgres/schema.js';
import {
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { logger } from '../../src/utils/logger.js';
import { quoteIdentifier } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('MCAA-260 — corpus tables migration round trip', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  async function tableExists(table: string): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, table],
    );
    return result.rows.length === 1;
  }

  async function indexExists(index: string): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
      [schemaName, index],
    );
    return result.rows.length === 1;
  }

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_mcaa260_migration_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
  });

  afterEach(async () => {
    try { await client.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`); } catch { /* best effort */ }
    client.release();
    await pool.end();
    for (const spy of loggerSpies) spy.mockRestore();
    loggerSpies = [];
  });

  it('applies forward, rolls back, and re-applies without losing observations', async () => {
    for (const table of ['corpora', 'corpus_members', 'corpus_artifacts']) {
      expect(await tableExists(table)).toBe(true);
    }
    expect(await indexExists('idx_corpus_members_observation')).toBe(true);
    expect(await indexExists('idx_observations_metadata')).toBe(true);

    const team = await storage.teams.create({ name: 'migration-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'migration-project' });
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: team.id,
      content: 'observation written before the corpus rollback',
    });
    const built = await storage.corpora.upsert({
      projectId: project.id,
      teamId: team.id,
      name: 'rollback-corpus',
      description: 'exists only to be rolled back',
      filter: {},
      filterDigest: 'sha256:test',
      memberScope: 'project',
      shared: false,
    });
    await storage.corpora.replaceMembers({
      corpusId: built.corpus.id,
      projectId: project.id,
      teamId: team.id,
      filter: {},
      breadth: 'project',
      shared: false,
      limit: 100,
    });
    const members = await storage.corpora.listMembers({
      corpusId: built.corpus.id,
      readerProjectId: project.id,
      readerTeamId: team.id,
    });
    expect(members.map(member => member.id)).toEqual([observation.id]);

    // Down.
    await client.query(CORPUS_DOWN_SQL);
    for (const table of ['corpora', 'corpus_members', 'corpus_artifacts']) {
      expect(await tableExists(table)).toBe(false);
    }
    expect(await indexExists('idx_observations_metadata')).toBe(false);

    // Observations are untouched: a corpus is derived state, and the rollback
    // drops the derivation, never the captured memory.
    const afterDown = await client.query('SELECT id, content FROM observations');
    expect(afterDown.rows).toEqual([
      { id: observation.id, content: 'observation written before the corpus rollback' },
    ]);

    // Up again — the idempotent bootstrap re-creates the tables empty. The
    // corpus does not come back; an operator re-runs build_corpus.
    await bootstrapServerPostgresSchema(client);
    for (const table of ['corpora', 'corpus_members', 'corpus_artifacts']) {
      expect(await tableExists(table)).toBe(true);
    }
    const afterUp = await client.query('SELECT count(*)::int AS count FROM corpora');
    expect(afterUp.rows[0]).toEqual({ count: 0 });

    const rebuilt = await createPostgresStorageRepositories(client).corpora.upsert({
      projectId: project.id,
      teamId: team.id,
      name: 'rollback-corpus',
      description: 'rebuilt after the rollback',
      filter: {},
      filterDigest: 'sha256:test',
      memberScope: 'project',
      shared: false,
    });
    expect(rebuilt.created).toBe(true);
  });

  it('is idempotent when the bootstrap runs twice', async () => {
    await bootstrapServerPostgresSchema(client);
    await bootstrapServerPostgresSchema(client);
    expect(await tableExists('corpora')).toBe(true);
  });

  it('is idempotent when the down SQL runs twice', async () => {
    await client.query(CORPUS_DOWN_SQL);
    await client.query(CORPUS_DOWN_SQL);
    expect(await tableExists('corpora')).toBe(false);
  });

  // Condition 23. The build gate only refuses new selections; a corpus
  // materialized before it keeps its foreign members at rest and keeps answering
  // the same question through observationCount.
  describe('the pre-gate purge', () => {
    async function pregateCorpus(filter: Record<string, unknown>, memberScope: 'project' | 'shared') {
      const team = await storage.teams.create({ name: `purge-team-${crypto.randomUUID()}` });
      const project = await storage.projects.create({ teamId: team.id, name: 'purge-project' });
      await storage.observations.create({
        projectId: project.id,
        teamId: team.id,
        content: 'a shared observation selected by a hidden predicate',
        metadata: { incidentId: 'INC-4471' },
        shared: true,
      });
      const { corpus } = await storage.corpora.upsert({
        projectId: project.id,
        teamId: team.id,
        name: 'pregate',
        description: '',
        filter: {},
        filterDigest: 'sha256:test',
        memberScope,
        shared: false,
      });
      await storage.corpora.replaceMembers({
        corpusId: corpus.id,
        projectId: project.id,
        teamId: team.id,
        filter: {},
        breadth: 'project',
        shared: false,
        limit: 100,
      });
      await storage.corpora.upsertArtifact({
        corpusId: corpus.id,
        contentDigest: 'sha256:pregate',
        systemPrompt: 'rendered from a member set the gate now refuses',
        rendered: 'a shared observation selected by a hidden predicate',
        tokenEstimate: 42,
      });
      await storage.corpora.setStats(corpus.id, { observationCount: 1, matchedCount: 1 });
      // Written directly: the gate refuses this filter through every code path
      // that could store it, which is exactly why only an old row can carry it.
      await client.query('UPDATE corpora SET filter = $2::jsonb WHERE id = $1', [
        corpus.id,
        JSON.stringify(filter),
      ]);
      return corpus.id;
    }

    async function countsFor(corpusId: string) {
      const row = await client.query(
        `SELECT
           (SELECT count(*)::int FROM corpus_members WHERE corpus_id = c.id) AS members,
           (SELECT count(*)::int FROM corpus_artifacts WHERE corpus_id = c.id) AS artifacts,
           c.stats::text AS stats,
           c.built_at IS NULL AS unbuilt
         FROM corpora c WHERE c.id = $1`,
        [corpusId],
      );
      return row.rows[0] as { members: number; artifacts: number; stats: string; unbuilt: boolean };
    }

    it('clears membership, cached renders and the counts they answer through', async () => {
      const corpusId = await pregateCorpus(
        { scope: 'shared', metadataMatch: { incidentId: 'INC-4471' } },
        'shared',
      );
      expect((await countsFor(corpusId)).members).toBe(1);

      await bootstrapServerPostgresSchema(client);

      const after = await countsFor(corpusId);
      expect(after.members).toBe(0);
      expect(after.artifacts).toBe(0);
      expect(JSON.parse(after.stats)).toEqual({});
      expect(after.unbuilt).toBe(true);
    });

    it('purges a platformSource selection for the same reason', async () => {
      const corpusId = await pregateCorpus({ scope: 'shared', platformSource: 'cursor' }, 'shared');
      await bootstrapServerPostgresSchema(client);
      expect((await countsFor(corpusId)).members).toBe(0);
    });

    // The corpus row survives so the operator still sees it and gets the
    // explaining 400 on rebuild, rather than a corpus that silently vanished.
    it('keeps the corpus row and its filter so the rebuild can explain itself', async () => {
      const corpusId = await pregateCorpus(
        { scope: 'shared', metadataMatch: { incidentId: 'INC-4471' } },
        'shared',
      );
      await bootstrapServerPostgresSchema(client);
      const row = await client.query('SELECT name, filter FROM corpora WHERE id = $1', [corpusId]);
      expect(row.rows[0].name).toBe('pregate');
      expect(row.rows[0].filter).toEqual({ scope: 'shared', metadataMatch: { incidentId: 'INC-4471' } });
    });

    // The predicate has to match ownerOnlyFilterFields exactly, or the purge
    // deletes a corpus the gate would have accepted.
    it.each([
      ['a project-scope corpus filtering on metadata', { scope: 'project', metadataMatch: { incidentId: 'INC-4471' } }, 'project' as const],
      ['a shared-scope corpus with an empty metadataMatch', { scope: 'shared', metadataMatch: {} }, 'shared' as const],
      ['a shared-scope corpus with a null platformSource', { scope: 'shared', platformSource: null }, 'shared' as const],
      ['a shared-scope corpus filtering only on projected fields', { scope: 'shared', kinds: ['decision'], query: 'rollback' }, 'shared' as const],
    ])('leaves %s alone', async (_label, filter, memberScope) => {
      const corpusId = await pregateCorpus(filter, memberScope);
      await bootstrapServerPostgresSchema(client);
      const after = await countsFor(corpusId);
      expect(after.members).toBe(1);
      expect(after.artifacts).toBe(1);
    });

    it('is idempotent when the bootstrap runs again after purging', async () => {
      const corpusId = await pregateCorpus(
        { scope: 'shared', metadataMatch: { incidentId: 'INC-4471' } },
        'shared',
      );
      await bootstrapServerPostgresSchema(client);
      await bootstrapServerPostgresSchema(client);
      const after = await countsFor(corpusId);
      expect(after.members).toBe(0);
      expect(after.artifacts).toBe(0);
    });
  });

  it('cascades a deleted observation out of every corpus it was a member of', async () => {
    const team = await storage.teams.create({ name: 'cascade-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'cascade-project' });
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: team.id,
      content: 'a memory that will be forgotten',
    });
    const { corpus } = await storage.corpora.upsert({
      projectId: project.id,
      teamId: team.id,
      name: 'cascade-corpus',
      description: '',
      filter: {},
      filterDigest: 'sha256:test',
      memberScope: 'project',
      shared: false,
    });
    await storage.corpora.replaceMembers({
      corpusId: corpus.id,
      projectId: project.id,
      teamId: team.id,
      filter: {},
      breadth: 'project',
      shared: false,
      limit: 100,
    });

    await client.query('DELETE FROM observations WHERE id = $1', [observation.id]);

    const remaining = await client.query('SELECT count(*)::int AS count FROM corpus_members WHERE corpus_id = $1', [corpus.id]);
    expect(remaining.rows[0]).toEqual({ count: 0 });
  });
});
