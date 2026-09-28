// SPDX-License-Identifier: Apache-2.0
//
// MCAA-241 — the server half of the re-runnable import contract.
//
// POST /v1/memories accepts an `idempotencyKey`. Writing the same key twice
// must return the stored row with `created: false`, leave the row count alone,
// and leave the stored row untouched. The key is scoped per tenant, and it
// cannot alias an observation the generation pipeline wrote.
//
// Requires a real Postgres (CLAUDE_MEM_TEST_POSTGRES_URL): the guarantee is a
// unique index plus ON CONFLICT, which a fake pool would not exercise.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { logger } from '../../../src/utils/logger.js';
import { createIsolatedSchema, dropSchema, newApiKey, poolForSchema } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

interface MemoryResponse {
  created?: boolean;
  memory: { id: string; content: string; metadata: Record<string, unknown>; updatedAtEpoch?: number };
}

describe('MCAA-241 — idempotent writes on POST /v1/memories', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }
  const databaseUrl = testDatabaseUrl;

  let pool: pg.Pool;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let teamId: string;
  let otherTeamId: string;
  let projectId: string;
  let otherProjectId: string;
  let key: string;
  let otherKey: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  async function post<T>(path: string, apiKey: string, body: unknown): Promise<{ status: number; json: T }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({})) as T;
    return { status: response.status, json };
  }

  async function countObservations(): Promise<number> {
    const result = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM observations');
    return Number(result.rows[0]?.count ?? '0');
  }

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    schemaName = await createIsolatedSchema(databaseUrl, 'cm_mcaa241_import');
    pool = poolForSchema(databaseUrl, schemaName);
    const client = await pool.connect();
    try {
      await bootstrapServerPostgresSchema(client);
    } finally {
      client.release();
    }
    storage = createPostgresStorageRepositories(pool);

    const team = await storage.teams.create({ name: 'importer' });
    const otherTeam = await storage.teams.create({ name: 'bystander' });
    teamId = team.id;
    otherTeamId = otherTeam.id;
    projectId = (await storage.projects.create({ teamId, name: 'homelab' })).id;
    otherProjectId = (await storage.projects.create({ teamId: otherTeamId, name: 'homelab' })).id;

    const material = newApiKey();
    key = material.raw;
    await storage.auth.createApiKey({
      keyHash: material.hash,
      teamId,
      projectId: null,
      actorId: 'system:mcaa241-importer',
      scopes: ['memories:read', 'memories:write'],
    });

    const otherMaterial = newApiKey();
    otherKey = otherMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: otherMaterial.hash,
      teamId: otherTeamId,
      projectId: null,
      actorId: 'system:mcaa241-bystander',
      scopes: ['memories:read', 'memories:write'],
    });

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled in tests'),
      authMode: 'api-key',
      getEventQueue: () => null,
      getSummaryQueue: () => null,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch { /* already down */ }
    await pool.end();
    await dropSchema(databaseUrl, schemaName);
    for (const spy of loggerSpies) spy.mockRestore();
    loggerSpies = [];
  });

  it('adds one row for the first write and nothing for the replay', async () => {
    const body = {
      projectId,
      kind: 'observation',
      content: 'imported from the local worker database',
      metadata: { source: 'sqlite-import' },
      idempotencyKey: 'import:sqlite-v1:observations:abc123',
    };

    const first = await post<MemoryResponse>('/v1/memories', key, body);
    expect(first.status).toBe(201);
    expect(first.json.created).toBe(true);
    expect(await countObservations()).toBe(1);

    const stored = await pool.query<{ id: string; content: string; updated_at: Date; generation_key: string }>(
      'SELECT id, content, updated_at, generation_key FROM observations',
    );
    expect(stored.rows[0]?.generation_key).toBe('client:v1:import:sqlite-v1:observations:abc123');

    const replay = await post<MemoryResponse>('/v1/memories', key, body);
    expect(replay.status).toBe(200);
    expect(replay.json.created).toBe(false);
    expect(replay.json.memory.id).toBe(first.json.memory.id);
    expect(await countObservations()).toBe(1);

    const after = await pool.query<{ id: string; content: string; updated_at: Date }>(
      'SELECT id, content, updated_at FROM observations',
    );
    expect(after.rows[0]?.updated_at.getTime()).toBe(stored.rows[0]!.updated_at.getTime());
    expect(after.rows[0]?.content).toBe(stored.rows[0]!.content);
  });

  it('keeps a replay with changed content from overwriting the stored row', async () => {
    const idempotencyKey = 'import:sqlite-v1:observations:stable';
    await post<MemoryResponse>('/v1/memories', key, {
      projectId, content: 'the original body', idempotencyKey,
    });
    const replay = await post<MemoryResponse>('/v1/memories', key, {
      projectId, content: 'a rewritten body', idempotencyKey,
    });
    expect(replay.status).toBe(200);
    expect(replay.json.created).toBe(false);
    expect(replay.json.memory.content).toBe('the original body');
    expect(await countObservations()).toBe(1);
  });

  it('treats a different key as a different row', async () => {
    await post('/v1/memories', key, { projectId, content: 'row one', idempotencyKey: 'a' });
    await post('/v1/memories', key, { projectId, content: 'row two', idempotencyKey: 'b' });
    expect(await countObservations()).toBe(2);
  });

  it('writes without an idempotency key exactly as before', async () => {
    const first = await post<MemoryResponse>('/v1/memories', key, { projectId, content: 'same text' });
    const second = await post<MemoryResponse>('/v1/memories', key, { projectId, content: 'same text' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json.created).toBe(true);
    expect(second.json.memory.id).not.toBe(first.json.memory.id);
    expect(await countObservations()).toBe(2);
  });

  it('scopes the key per tenant, so two tenants importing the same source do not collide', async () => {
    const idempotencyKey = 'import:sqlite-v1:observations:shared-row-id';
    const mine = await post<MemoryResponse>('/v1/memories', key, {
      projectId, content: 'my copy', idempotencyKey,
    });
    const theirs = await post<MemoryResponse>('/v1/memories', otherKey, {
      projectId: otherProjectId, content: 'their copy', idempotencyKey,
    });
    expect(mine.json.created).toBe(true);
    expect(theirs.json.created).toBe(true);
    expect(await countObservations()).toBe(2);
  });

  // ADR 0003 C1 — the route owns trimming, so a whitespace-only key is rejected
  // instead of collapsing into the bare `client:v1:` prefix that every other
  // whitespace-only key would also produce.
  it('rejects a whitespace-only idempotency key instead of coercing it', async () => {
    const attempt = await post<MemoryResponse>('/v1/memories', key, {
      projectId, content: 'should never be stored', idempotencyKey: '   ',
    });
    expect(attempt.status).toBe(400);
    expect(await countObservations()).toBe(0);
  });

  it('normalizes a padded key once, at the route boundary', async () => {
    const first = await post<MemoryResponse>('/v1/memories', key, {
      projectId, content: 'the original body', idempotencyKey: '  padded-key  ',
    });
    expect(first.status).toBe(201);
    const stored = await pool.query<{ generation_key: string }>('SELECT generation_key FROM observations');
    expect(stored.rows[0]?.generation_key).toBe('client:v1:padded-key');

    const replay = await post<MemoryResponse>('/v1/memories', key, {
      projectId, content: 'a rewritten body', idempotencyKey: 'padded-key',
    });
    expect(replay.status).toBe(200);
    expect(replay.json.created).toBe(false);
    expect(await countObservations()).toBe(1);
  });

  // ADR 0003 C4 — a replay wrote nothing, so `memory.write` would make the log
  // lie; but silence is indistinguishable from a dropped audit write, so the
  // no-op gets its own action and key probing stays visible.
  it('audits the replay as memory.write.duplicate and not as a write', async () => {
    const body = {
      projectId, content: 'imported once', idempotencyKey: 'import:sqlite-v1:observations:audited',
    };
    const first = await post<MemoryResponse>('/v1/memories', key, body);
    expect(first.status).toBe(201);
    await post<MemoryResponse>('/v1/memories', key, body);

    const audit = await pool.query<{ action: string; resource_type: string; resource_id: string }>(
      `SELECT action, resource_type, resource_id FROM audit_log
        WHERE action IN ('memory.write', 'memory.write.duplicate')
        ORDER BY created_at ASC`,
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['memory.write', 'memory.write.duplicate']);
    expect(audit.rows[1]?.resource_id).toBe(first.json.memory.id);
    expect(audit.rows[1]?.resource_type).toBe('observation');
  });

  it('cannot alias an observation the generation pipeline wrote', async () => {
    const generated = await new PostgresObservationRepository(pool).create({
      projectId,
      teamId,
      content: 'written by the generation pipeline',
      generationKey: 'generation:v1:job-1:0:deadbeef',
    });

    const attempt = await post<MemoryResponse>('/v1/memories', key, {
      projectId,
      content: 'trying to take over the generated row',
      idempotencyKey: 'generation:v1:job-1:0:deadbeef',
    });
    expect(attempt.status).toBe(201);
    expect(attempt.json.created).toBe(true);
    expect(attempt.json.memory.id).not.toBe(generated.id);
    expect(await countObservations()).toBe(2);
  });
});
