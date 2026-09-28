// SPDX-License-Identifier: Apache-2.0
//
// MCAA-237 — the shared-scope column must be safe to roll forward AND back on
// someone else's cluster, unattended. This exercises the real DDL: bootstrap →
// verify → apply SHARED_SCOPE_DOWN_SQL → verify gone → re-bootstrap → verify
// back, asserting existing observation rows survive the round trip.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  SHARED_SCOPE_DOWN_SQL,
} from '../../src/storage/postgres/schema.js';
import {
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { logger } from '../../src/utils/logger.js';
import { quoteIdentifier } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('MCAA-237 — observations.shared migration round trip', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  async function sharedColumnExists(): Promise<boolean> {
    const result = await client.query(
      `
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'observations' AND column_name = 'shared'
      `,
      [schemaName],
    );
    return result.rows.length === 1;
  }

  async function sharedIndexExists(): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_observations_shared'`,
      [schemaName],
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
    schemaName = `cm_mcaa237_migration_${crypto.randomUUID().replaceAll('-', '_')}`;
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

  it('applies forward, rolls back, and re-applies without losing observation rows', async () => {
    expect(await sharedColumnExists()).toBe(true);
    expect(await sharedIndexExists()).toBe(true);

    const team = await storage.teams.create({ name: 'migration-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'migration-project' });
    const privateRow = await storage.observations.create({
      projectId: project.id,
      teamId: team.id,
      content: 'row written before the rollback',
    });
    const sharedRow = await storage.observations.create({
      projectId: project.id,
      teamId: team.id,
      content: 'shared row written before the rollback',
      shared: true,
    });
    expect(privateRow.shared).toBe(false);
    expect(sharedRow.shared).toBe(true);

    // Down.
    await client.query(SHARED_SCOPE_DOWN_SQL);
    expect(await sharedColumnExists()).toBe(false);
    expect(await sharedIndexExists()).toBe(false);

    // Rows themselves survive the column drop.
    const afterDown = await client.query('SELECT id, content FROM observations ORDER BY content');
    expect(afterDown.rows.map((r: { content: string }) => r.content)).toEqual([
      'row written before the rollback',
      'shared row written before the rollback',
    ]);

    // Up again — idempotent bootstrap re-adds the column with its false default.
    await bootstrapServerPostgresSchema(client);
    expect(await sharedColumnExists()).toBe(true);
    expect(await sharedIndexExists()).toBe(true);

    const afterUp = await client.query('SELECT content, shared FROM observations ORDER BY content');
    expect(afterUp.rows).toEqual([
      { content: 'row written before the rollback', shared: false },
      // The previously-shared row comes back private: a rollback drops the
      // publication, it does not remember it. Operators must re-publish.
      { content: 'shared row written before the rollback', shared: false },
    ]);
  });

  it('is idempotent when the bootstrap runs twice', async () => {
    await bootstrapServerPostgresSchema(client);
    await bootstrapServerPostgresSchema(client);
    expect(await sharedColumnExists()).toBe(true);
    expect(await sharedIndexExists()).toBe(true);
  });

  it('is idempotent when the down SQL runs twice', async () => {
    await client.query(SHARED_SCOPE_DOWN_SQL);
    await client.query(SHARED_SCOPE_DOWN_SQL);
    expect(await sharedColumnExists()).toBe(false);
  });
});
