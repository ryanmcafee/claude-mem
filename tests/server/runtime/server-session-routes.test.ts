// SPDX-License-Identifier: Apache-2.0

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
import { readJson } from '../../helpers/http-json.js';
import { quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

interface SessionBody {
  id: string;
  platformSource: string | null;
  endedAtEpoch: number | null;
}

interface GenerationJobBody {
  id: string;
  sourceType: string;
}

interface EventBody {
  id: string;
  serverSessionId: string | null;
  platformSource: string | null;
}

interface SessionStartResponse {
  session: SessionBody;
}

interface SessionEndResponse {
  session: SessionBody;
  generationJob: GenerationJobBody;
}

interface EventResponse {
  event: EventBody;
}

interface EventBatchResponse {
  events: { event: EventBody }[];
}

interface SearchResponse {
  observations: { content: string }[];
}

interface ContextResponse {
  context: string;
}

describe('ServerV1PostgresRoutes Phase 6 session endpoints', () => {
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
  let teamId: string;
  let projectId: string;
  let apiKeyRaw: string;
  let enqueuedEventJobs: { id: string; payload: unknown }[] = [];
  let enqueuedSummaryJobs: { id: string; payload: unknown }[] = [];
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_phase6_routes_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;

    const { raw, hash } = newApiKey();
    apiKeyRaw = raw;
    await storage.auth.createApiKey({
      keyHash: hash,
      teamId,
      projectId,
      actorId: 'test',
      scopes: ['memories:read', 'memories:write'],
    });

    enqueuedEventJobs = [];
    enqueuedSummaryJobs = [];

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
      getEventQueue: () => ({
        async add(jobId: string, payload: unknown) {
          enqueuedEventJobs.push({ id: jobId, payload });
        },
        async getJob() { return null; },
        async remove() {},
      }) as never,
      getSummaryQueue: () => ({
        async add(jobId: string, payload: unknown) {
          enqueuedSummaryJobs.push({ id: jobId, payload });
        },
        async getJob() { return null; },
        async remove() {},
      }) as never,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${apiKeyRaw}`,
        'Content-Type': 'application/json',
      },
    });
  }

  it('POST /v1/sessions/start is idempotent on legacy no-platform external_session_id', async () => {
    const a = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'ext-1' }),
    });
    expect(a.status).toBe(201);
    const aJson = await readJson<SessionStartResponse>(a);
    const b = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'ext-1' }),
    });
    expect(b.status).toBe(200);
    const bJson = await readJson<SessionStartResponse>(b);
    expect(bJson.session.id).toBe(aJson.session.id);
  });

  it('POST /v1/sessions/start scopes external_session_id by normalized platformSource', async () => {
    const cursor = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'shared-ext', platformSource: 'Cursor' }),
    });
    expect(cursor.status).toBe(201);
    const cursorJson = await readJson<SessionStartResponse>(cursor);
    expect(cursorJson.session.platformSource).toBe('cursor');

    const cursorAgain = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'shared-ext', platformSource: 'cursor-cli' }),
    });
    expect(cursorAgain.status).toBe(200);
    const cursorAgainJson = await readJson<SessionStartResponse>(cursorAgain);
    expect(cursorAgainJson.session.id).toBe(cursorJson.session.id);

    const codex = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'shared-ext', platformSource: 'Codex CLI' }),
    });
    expect(codex.status).toBe(201);
    const codexJson = await readJson<SessionStartResponse>(codex);
    expect(codexJson.session.platformSource).toBe('codex');
    expect(codexJson.session.id).not.toBe(cursorJson.session.id);

    const legacy = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'shared-ext' }),
    });
    expect(legacy.status).toBe(201);
    const legacyJson = await readJson<SessionStartResponse>(legacy);
    expect(legacyJson.session.platformSource).toBeNull();
    expect(legacyJson.session.id).not.toBe(cursorJson.session.id);
    expect(legacyJson.session.id).not.toBe(codexJson.session.id);
  });

  it('POST /v1/sessions/:id/end enqueues exactly one summary job, idempotent on re-end', async () => {
    const startResp = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'ext-end' }),
    });
    const { session } = await readJson<SessionStartResponse>(startResp);

    const end1 = await authedFetch(`/v1/sessions/${session.id}/end`, { method: 'POST' });
    expect(end1.status).toBe(200);
    const end1Json = await readJson<SessionEndResponse>(end1);
    expect(end1Json.generationJob.sourceType).toBe('session_summary');
    expect(end1Json.session.endedAtEpoch).not.toBeNull();
    expect(enqueuedSummaryJobs.length).toBe(1);

    const end2 = await authedFetch(`/v1/sessions/${session.id}/end`, { method: 'POST' });
    expect(end2.status).toBe(200);
    const end2Json = await readJson<SessionEndResponse>(end2);
    // Same generation job id (UNIQUE collapse).
    expect(end2Json.generationJob.id).toBe(end1Json.generationJob.id);
    // Re-ending may still publish to the queue (BullMQ add() is idempotent on
    // jobId), but the outbox row count is unchanged. We assert the outbox
    // collapse rather than queue-publish count.
    const allJobs = await storage.observationGenerationJobs.listByStatusForScope({
      status: 'queued',
      projectId,
      teamId,
    });
    const summaryJobs = allJobs.filter(j => j.sourceType === 'session_summary');
    expect(summaryJobs.length).toBe(1);
  });

  it('GET /v1/sessions/:id returns 404 for cross-project requests', async () => {
    // Create a foreign project + session under a different team.
    const otherTeam = await storage.teams.create({ name: 'other' });
    const otherProject = await storage.projects.create({ teamId: otherTeam.id, name: 'other-p' });
    const otherSession = await storage.sessions.create({
      teamId: otherTeam.id,
      projectId: otherProject.id,
      externalSessionId: 'foreign',
    });

    const resp = await authedFetch(`/v1/sessions/${otherSession.id}`);
    expect(resp.status).toBe(404);
  });

  it('POST /v1/events with per-event policy enqueues immediately', async () => {
    const startResp = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'ext-evt' }),
    });
    const { session } = await readJson<SessionStartResponse>(startResp);

    const eventResp = await authedFetch('/v1/events', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        serverSessionId: session.id,
        sourceType: 'api',
        eventType: 'tool_use',
        payload: { tool: 'read' },
        occurredAtEpoch: Date.now(),
      }),
    });
    expect(eventResp.status).toBe(201);
    expect(enqueuedEventJobs.length).toBe(1);
  });

  it('POST /v1/events links by normalized platformSource when resolving contentSessionId', async () => {
    const cursorStart = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        externalSessionId: 'shared-content-link',
        contentSessionId: 'shared-content-link',
        platformSource: 'Cursor',
      }),
    });
    const { session: cursorSession } = await readJson<SessionStartResponse>(cursorStart);
    await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        externalSessionId: 'shared-content-link',
        contentSessionId: 'shared-content-link',
        platformSource: 'Codex CLI',
      }),
    });

    const eventResp = await authedFetch('/v1/events', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        contentSessionId: 'shared-content-link',
        platformSource: 'cursor-cli',
        sourceType: 'api',
        eventType: 'tool_use',
        payload: { tool: 'Read' },
        occurredAtEpoch: Date.now(),
      }),
    });
    expect(eventResp.status).toBe(201);
    const eventJson = await readJson<EventResponse>(eventResp);
    expect(eventJson.event.serverSessionId).toBe(cursorSession.id);
    expect(eventJson.event.platformSource).toBe('cursor');
  });

  it('POST /v1/events with explicit platformSource null links only the legacy contentSessionId session', async () => {
    const legacyStart = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        externalSessionId: 'explicit-null-content-link',
        contentSessionId: 'explicit-null-content-link',
        platformSource: null,
      }),
    });
    const { session: legacySession } = await readJson<SessionStartResponse>(legacyStart);
    await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        externalSessionId: 'explicit-null-content-link',
        contentSessionId: 'explicit-null-content-link',
        platformSource: 'Cursor',
      }),
    });

    const eventResp = await authedFetch('/v1/events?generate=false', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        contentSessionId: 'explicit-null-content-link',
        platformSource: null,
        sourceType: 'api',
        eventType: 'tool_use',
        payload: { tool: 'LegacyNull' },
        occurredAtEpoch: Date.now(),
      }),
    });
    expect(eventResp.status).toBe(201);
    const eventJson = await readJson<EventResponse>(eventResp);
    expect(eventJson.event.serverSessionId).toBe(legacySession.id);
    expect(eventJson.event.platformSource).toBeNull();
  });

  it('POST /v1/events/batch links each event by normalized platformSource without requiring a session match', async () => {
    const cursorStart = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        externalSessionId: 'batch-shared-content',
        contentSessionId: 'batch-shared-content',
        platformSource: 'Cursor',
      }),
    });
    const { session: cursorSession } = await readJson<SessionStartResponse>(cursorStart);
    const codexStart = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        externalSessionId: 'batch-shared-content',
        contentSessionId: 'batch-shared-content',
        platformSource: 'Codex CLI',
      }),
    });
    const { session: codexSession } = await readJson<SessionStartResponse>(codexStart);

    const batchResp = await authedFetch('/v1/events/batch?generate=false', {
      method: 'POST',
      body: JSON.stringify([
        {
          projectId,
          contentSessionId: 'batch-shared-content',
          platformSource: 'cursor-cli',
          sourceType: 'api',
          eventType: 'tool_use',
          payload: { index: 1 },
          occurredAtEpoch: Date.now(),
        },
        {
          projectId,
          contentSessionId: 'batch-shared-content',
          platformSource: 'Codex',
          sourceType: 'api',
          eventType: 'tool_use',
          payload: { index: 2 },
          occurredAtEpoch: Date.now() + 1,
        },
        {
          projectId,
          contentSessionId: 'missing-batch-content-session',
          platformSource: 'cursor',
          sourceType: 'api',
          eventType: 'tool_use',
          payload: { index: 3 },
          occurredAtEpoch: Date.now() + 2,
        },
      ]),
    });
    expect(batchResp.status).toBe(201);
    const batchJson = await readJson<EventBatchResponse>(batchResp);
    expect(batchJson.events.map(item => item.event.serverSessionId)).toEqual([
      cursorSession.id,
      codexSession.id,
      null,
    ]);
    expect(batchJson.events.map(item => item.event.platformSource)).toEqual([
      'cursor',
      'codex',
      'cursor',
    ]);
  });

  it('POST /v1/search and /v1/context normalize platformSource filters', async () => {
    const cursorSession = await storage.sessions.create({
      projectId,
      teamId,
      externalSessionId: 'cursor-search-session',
      platformSource: 'cursor',
    });
    const codexSession = await storage.sessions.create({
      projectId,
      teamId,
      externalSessionId: 'codex-search-session',
      platformSource: 'codex',
    });
    await storage.observations.create({
      projectId,
      teamId,
      serverSessionId: cursorSession.id,
      content: 'platformscoped cursor observation',
    });
    await storage.observations.create({
      projectId,
      teamId,
      serverSessionId: codexSession.id,
      content: 'platformscoped codex observation',
    });

    const search = await authedFetch('/v1/search', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        query: 'platformscoped',
        platformSource: 'Cursor CLI',
      }),
    });
    expect(search.status).toBe(200);
    const searchJson = await readJson<SearchResponse>(search);
    expect(searchJson.observations.map(item => item.content)).toEqual([
      'platformscoped cursor observation',
    ]);

    const context = await authedFetch('/v1/context', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        query: 'platformscoped',
        platformSource: 'Cursor',
      }),
    });
    expect(context.status).toBe(200);
    const contextJson = await readJson<ContextResponse>(context);
    expect(contextJson.context).toContain('platformscoped cursor observation');
    expect(contextJson.context).not.toContain('platformscoped codex observation');
  });
});
