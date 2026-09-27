// SPDX-License-Identifier: Apache-2.0
//
// MCAA-237 — tenant isolation over the remote API.
//
// The guarantee under test: the API key is the tenant binding, and isolation is
// enforced server-side. A client cannot reach another tenant's rows by omitting
// a scope, by forging a projectId, or by asking for the shared scope. The shared
// scope is the ONE opt-in that crosses tenants, and publishing into it needs its
// own grant.
//
// Requires a real Postgres (CLAUDE_MEM_TEST_POSTGRES_URL) — the isolation lives
// in SQL WHERE clauses, so a fake pool would prove nothing.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { logger } from '../../../src/utils/logger.js';
import { quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

interface SearchResponse {
  observations: Array<{ id: string; content: string; teamId: string; shared: boolean }>;
  context?: string;
}

describe('MCAA-237 — multi-tenant isolation on the remote API', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;

  // Two tenants that must never see each other. Both use the SAME project name
  // so the test cannot pass by accident just because project ids differ.
  let teamAId: string;
  let teamBId: string;
  let projectAId: string;
  let projectBId: string;
  let keyA: string;
  let keyB: string;
  // Tenant A also gets a key WITH the shared-write grant, to separate "may
  // publish" from "may write".
  let keyAPublisher: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  async function post<T>(path: string, key: string, body: unknown): Promise<{ status: number; json: T }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({})) as T;
    return { status: response.status, json };
  }

  async function del<T>(path: string, key: string): Promise<{ status: number; json: T }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
    });
    const json = await response.json().catch(() => ({})) as T;
    return { status: response.status, json };
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
    schemaName = `cm_mcaa237_isolation_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const teamA = await storage.teams.create({ name: 'tenant-a' });
    const teamB = await storage.teams.create({ name: 'tenant-b' });
    teamAId = teamA.id;
    teamBId = teamB.id;
    const projectA = await storage.projects.create({ teamId: teamAId, name: 'homelab' });
    const projectB = await storage.projects.create({ teamId: teamBId, name: 'homelab' });
    projectAId = projectA.id;
    projectBId = projectB.id;

    const materialA = newApiKey();
    keyA = materialA.raw;
    await storage.auth.createApiKey({
      keyHash: materialA.hash,
      teamId: teamAId,
      projectId: null,
      actorId: 'system:mcaa237-tenant-a',
      scopes: ['memories:read', 'memories:write'],
    });

    const materialB = newApiKey();
    keyB = materialB.raw;
    await storage.auth.createApiKey({
      keyHash: materialB.hash,
      teamId: teamBId,
      projectId: null,
      actorId: 'system:mcaa237-tenant-b',
      scopes: ['memories:read', 'memories:write'],
    });

    const materialPublisher = newApiKey();
    keyAPublisher = materialPublisher.raw;
    await storage.auth.createApiKey({
      keyHash: materialPublisher.hash,
      teamId: teamAId,
      projectId: null,
      actorId: 'system:mcaa237-tenant-a-publisher',
      scopes: ['memories:read', 'memories:write', 'memories:write:shared'],
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
    try { await server.close(); } catch { /* server may already be down */ }
    try { await client.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`); } catch { /* best effort */ }
    client.release();
    await pool.end();
    for (const spy of loggerSpies) spy.mockRestore();
    loggerSpies = [];
  });

  it('gives each tenant only its own observations for the same query', async () => {
    const writeA = await post('/v1/memories', keyA, {
      projectId: projectAId,
      content: 'tenant alpha deployment runbook',
    });
    expect(writeA.status).toBe(201);
    const writeB = await post('/v1/memories', keyB, {
      projectId: projectBId,
      content: 'tenant bravo deployment runbook',
    });
    expect(writeB.status).toBe(201);

    const readA = await post<SearchResponse>('/v1/search', keyA, {
      projectId: projectAId,
      query: 'deployment runbook',
    });
    expect(readA.status).toBe(200);
    expect(readA.json.observations.map(o => o.content)).toEqual(['tenant alpha deployment runbook']);
    expect(readA.json.observations.every(o => o.teamId === teamAId)).toBe(true);

    const readB = await post<SearchResponse>('/v1/search', keyB, {
      projectId: projectBId,
      query: 'deployment runbook',
    });
    expect(readB.status).toBe(200);
    expect(readB.json.observations.map(o => o.content)).toEqual(['tenant bravo deployment runbook']);
    expect(readB.json.observations.every(o => o.teamId === teamBId)).toBe(true);
  });

  it('returns nothing when a tenant forges the other tenant\'s projectId', async () => {
    await post('/v1/memories', keyB, {
      projectId: projectBId,
      content: 'tenant bravo secret credential rotation plan',
    });

    // Tenant A knows B's project id and asks for it directly. The team filter
    // comes from the API key, so the row is unreachable.
    const forged = await post<SearchResponse>('/v1/search', keyA, {
      projectId: projectBId,
      query: 'credential rotation',
    });
    expect(forged.status).toBe(200);
    expect(forged.json.observations).toEqual([]);

    const forgedContext = await post<SearchResponse>('/v1/context', keyA, {
      projectId: projectBId,
      query: 'credential rotation',
    });
    expect(forgedContext.status).toBe(200);
    expect(forgedContext.json.observations).toEqual([]);
    expect(forgedContext.json.context).toBe('');
  });

  it('cannot write into another tenant by forging a projectId', async () => {
    // projectB belongs to team B; the insert is scoped to the key's team, so the
    // project/team composite FK has no matching row.
    const forgedWrite = await post('/v1/memories', keyA, {
      projectId: projectBId,
      content: 'planted by tenant alpha',
    });
    expect(forgedWrite.status).toBeGreaterThanOrEqual(400);

    const readB = await post<SearchResponse>('/v1/search', keyB, {
      projectId: projectBId,
      query: 'planted',
    });
    expect(readB.json.observations).toEqual([]);
  });

  it('rejects a request with no API key and one with an unknown key', async () => {
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectAId, query: 'anything' }),
    });
    expect(anonymous.status).toBe(401);

    const forgedKey = await post('/v1/search', 'cm_not_a_real_key', {
      projectId: projectAId,
      query: 'anything',
    });
    expect(forgedKey.status).toBe(403);
  });

  it('returns both tenants only for an explicit shared-scope query', async () => {
    const published = await post('/v1/memories', keyAPublisher, {
      projectId: projectAId,
      content: 'shared knowledge: rollbacks use the previous ArgoCD revision',
      shared: true,
    });
    expect(published.status).toBe(201);

    await post('/v1/memories', keyB, {
      projectId: projectBId,
      content: 'shared knowledge lives in tenant bravo too',
    });

    // Default scope: tenant B sees only its own row, even though a shared row matches.
    const defaultScope = await post<SearchResponse>('/v1/search', keyB, {
      projectId: projectBId,
      query: 'shared knowledge',
    });
    expect(defaultScope.json.observations.map(o => o.teamId)).toEqual([teamBId]);

    // Opt in: tenant B now also sees tenant A's published row.
    const sharedScope = await post<SearchResponse>('/v1/search', keyB, {
      projectId: projectBId,
      query: 'shared knowledge',
      scope: 'shared',
    });
    const teams = sharedScope.json.observations.map(o => o.teamId).sort();
    expect(teams).toEqual([teamAId, teamBId].sort());
    expect(sharedScope.json.observations.some(o => o.shared)).toBe(true);
  });

  it('does not leak a tenant\'s private rows through the shared scope', async () => {
    await post('/v1/memories', keyA, {
      projectId: projectAId,
      content: 'private alpha incident postmortem',
    });

    const sharedScope = await post<SearchResponse>('/v1/search', keyB, {
      projectId: projectBId,
      query: 'incident postmortem',
      scope: 'shared',
    });
    expect(sharedScope.status).toBe(200);
    expect(sharedScope.json.observations).toEqual([]);
  });

  it('refuses to publish to the shared scope without the shared-write grant', async () => {
    const attempt = await post<{ message?: string }>('/v1/memories', keyA, {
      projectId: projectAId,
      content: 'alpha tries to publish without the grant',
      shared: true,
    });
    expect(attempt.status).toBe(403);
    expect(attempt.json.message).toContain('memories:write:shared');

    // And nothing was written: the guard runs before the insert.
    const sharedScope = await post<SearchResponse>('/v1/search', keyB, {
      projectId: projectBId,
      query: 'publish without the grant',
      scope: 'shared',
    });
    expect(sharedScope.json.observations).toEqual([]);
  });

  it('rejects an unrecognised scope value rather than guessing', async () => {
    // REST fails closed with a 400. The MCP tool path narrows an unrecognised
    // value to 'project' instead (see tests/server/mcp/recall-mcp-server.test.ts);
    // both refuse to widen the read.
    for (const scope of ['all', 'global', 'SHARED', '*']) {
      const response = await post<{ error?: string }>('/v1/search', keyA, {
        projectId: projectAId,
        query: 'anything',
        scope,
      });
      expect(response.status).toBe(400);
      expect(response.json.error).toBe('ValidationError');
    }
  });

  it('makes a shared observation readable cross-tenant but deletable only by its owner', async () => {
    const published = await post<{ memory: { id: string } }>('/v1/memories', keyAPublisher, {
      projectId: projectAId,
      content: 'shared runbook: drain the node before the kernel upgrade',
      shared: true,
    });
    expect(published.status).toBe(201);
    const sharedId = published.json.memory.id;

    const searchAsB = () => post<SearchResponse>('/v1/search', keyB, {
      projectId: projectBId,
      query: 'kernel upgrade',
      scope: 'shared',
    });

    const visible = await searchAsB();
    expect(visible.json.observations.map(o => o.id)).toEqual([sharedId]);

    // Reading a shared row does not confer write access. The delete filters on
    // the key's team, and 404 rather than 403 keeps existence unrevealed.
    const forgedDelete = await del(`/v1/memories/${sharedId}`, keyB);
    expect(forgedDelete.status).toBe(404);

    const stillVisible = await searchAsB();
    expect(stillVisible.json.observations.map(o => o.id)).toEqual([sharedId]);

    const ownerDelete = await del<{ deleted: boolean }>(`/v1/memories/${sharedId}`, keyA);
    expect(ownerDelete.status).toBe(200);
    expect(ownerDelete.json.deleted).toBe(true);

    const gone = await searchAsB();
    expect(gone.json.observations).toEqual([]);
  });

  it('treats a write with no shared flag as team-private', async () => {
    await post('/v1/memories', keyAPublisher, {
      projectId: projectAId,
      content: 'alpha default visibility note',
    });

    const sharedScope = await post<SearchResponse>('/v1/search', keyB, {
      projectId: projectBId,
      query: 'default visibility',
      scope: 'shared',
    });
    expect(sharedScope.json.observations).toEqual([]);
  });
});
