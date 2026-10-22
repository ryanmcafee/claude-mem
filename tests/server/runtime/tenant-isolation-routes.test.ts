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
// MCAA-281 extends this with the field-level half of the same guarantee: a row
// the caller reached through the shared branch carries the published content and
// nothing about who published it — no project id, session id, team id, or
// publisher-controlled metadata, on REST or MCP.
//
// Requires a real Postgres (CLAUDE_MEM_TEST_POSTGRES_URL) — the isolation lives
// in SQL WHERE clauses, so a fake pool would prove nothing.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

// Cross-tenant rows come back projected, so every provenance field is optional
// on the wire. The tests assert on their absence, which is the point.
interface WireObservation {
  id: string;
  content: string;
  kind: string;
  shared: boolean;
  sharedOrigin?: string;
  teamId?: string;
  projectId?: string;
  serverSessionId?: string | null;
  metadata?: Record<string, unknown>;
}

interface SearchResponse {
  observations: WireObservation[];
  context?: string;
}

// Publisher-controlled metadata a projected row must not carry back out.
// `agentId` is what the hook write path injects (services/hooks/server-client.ts);
// the nested marker proves the projection drops the whole object, not top-level keys.
const PUBLISHER_AGENT_ID = 'agent-acme-curator-7';
const NESTED_MARKER = 'acme-nested-provenance-marker';
const PUBLISHER_METADATA = {
  agentId: PUBLISHER_AGENT_ID,
  origin: { marker: NESTED_MARKER, projectId: 'acme-internal-pki' },
};

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
  // so the test cannot pass by accident just because project names differ.
  // `projects.id` is caller-supplied TEXT — in practice a repository or
  // directory name — so the ids are the real thing a leak would expose.
  const PROJECT_A_ID = 'acme-internal-pki';
  const PROJECT_A2_ID = 'acme-payments';
  const PROJECT_B_ID = 'bravo-web';
  let teamAId: string;
  let teamBId: string;
  let projectAId: string;
  let projectBId: string;
  // A second project inside tenant A: a row published from here is same-team but
  // outside the queried project scope, so it is only reachable via the shared branch.
  let projectA2Id: string;
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

  // The MCP recall tools read the same rows as REST, so they get the same
  // redaction assertions. Driven with the real MCP client over streamable HTTP.
  async function callMcpTool(
    key: string,
    name: 'search' | 'context' | 'recent',
    args: Record<string, unknown>,
  ): Promise<{ raw: string; observations: WireObservation[]; context?: string }> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/v1/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${key}` } } },
    );
    const mcp = new McpClient({ name: 'tenant-isolation-test', version: '0' }, { capabilities: {} });
    await mcp.connect(transport);
    try {
      const result = await mcp.callTool({ name, arguments: args });
      const raw = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      const parsed = JSON.parse(raw) as { observations: WireObservation[]; context?: string };
      return { raw, observations: parsed.observations, context: parsed.context };
    } finally {
      await mcp.close();
    }
  }

  // Provenance a row tenant B reached through the shared branch must never
  // carry, on any surface. `projected` is the subset of the response that came
  // from tenant A; `rawBody` is the whole serialized response, so a leak through
  // a nested or renamed field fails here too.
  function expectTenantAProvenanceRedacted(rawBody: string, projected: WireObservation[]): void {
    expect(projected.length).toBeGreaterThan(0);
    for (const secret of [PROJECT_A_ID, PROJECT_A2_ID, teamAId, PUBLISHER_AGENT_ID, NESTED_MARKER]) {
      expect(rawBody).not.toContain(secret);
    }
    for (const observation of projected) {
      expect(observation.projectId).toBeUndefined();
      expect(observation.teamId).toBeUndefined();
      expect(observation.serverSessionId).toBeUndefined();
      expect(observation.metadata).toBeUndefined();
      expect(observation.sharedOrigin).toBeString();
      expect(observation.shared).toBe(true);
    }
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
    const projectA = await storage.projects.create({ id: PROJECT_A_ID, teamId: teamAId, name: 'homelab' });
    const projectA2 = await storage.projects.create({ id: PROJECT_A2_ID, teamId: teamAId, name: 'homelab' });
    const projectB = await storage.projects.create({ id: PROJECT_B_ID, teamId: teamBId, name: 'homelab' });
    projectAId = projectA.id;
    projectA2Id = projectA2.id;
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

    // Opt in: tenant B now also sees tenant A's published row — as content plus
    // an opaque origin token, while its own row keeps full fidelity.
    const sharedScope = await post<SearchResponse>('/v1/search', keyB, {
      projectId: projectBId,
      query: 'shared knowledge',
      scope: 'shared',
    });
    expect(sharedScope.json.observations).toHaveLength(2);
    const own = sharedScope.json.observations.filter(o => o.teamId === teamBId);
    const projected = sharedScope.json.observations.filter(o => o.teamId === undefined);
    expect(own).toHaveLength(1);
    expect(own[0]!.projectId).toBe(projectBId);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.content).toContain('previous ArgoCD revision');
    expect(projected[0]!.shared).toBe(true);
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

  // MCAA-281 — the projection. Publishing content is not publishing provenance,
  // so every shared read surface reduces a foreign row to content + an opaque
  // origin token. Each of these fails against the pre-MCAA-281 serializer.
  describe('MCAA-281 — shared reads carry no publisher provenance', () => {
    // The scenario from the review: a curator publishes a runbook from a project
    // whose id is a repository name, with the write path's injected agentId and
    // nested provenance in metadata.
    async function publishRunbook(): Promise<string> {
      const published = await post<{ memory: { id: string } }>('/v1/memories', keyAPublisher, {
        projectId: projectAId,
        content: 'shared runbook: rotate the intermediate CA before the leaf expires',
        metadata: PUBLISHER_METADATA,
        shared: true,
      });
      expect(published.status).toBe(201);
      return published.json.memory.id;
    }

    it('redacts the publisher on REST /v1/search', async () => {
      const sharedId = await publishRunbook();
      const read = await post<SearchResponse>('/v1/search', keyB, {
        projectId: projectBId,
        query: 'intermediate CA',
        scope: 'shared',
      });
      expect(read.status).toBe(200);
      expect(read.json.observations.map(o => o.id)).toEqual([sharedId]);
      expectTenantAProvenanceRedacted(JSON.stringify(read.json), read.json.observations);
    });

    it('redacts the publisher on REST /v1/context, including the packed context string', async () => {
      await publishRunbook();
      const read = await post<SearchResponse>('/v1/context', keyB, {
        projectId: projectBId,
        query: 'intermediate CA',
        scope: 'shared',
      });
      expect(read.status).toBe(200);
      expectTenantAProvenanceRedacted(JSON.stringify(read.json), read.json.observations);
      // The content itself is the point of publishing, so it still packs.
      expect(read.json.context).toContain('rotate the intermediate CA');
    });

    for (const tool of ['search', 'context'] as const) {
      it(`redacts the publisher on the MCP ${tool} tool`, async () => {
        const sharedId = await publishRunbook();
        const result = await callMcpTool(keyB, tool, {
          projectId: projectBId,
          query: 'intermediate CA',
          scope: 'shared',
        });
        expect(result.observations.map(o => o.id)).toEqual([sharedId]);
        expectTenantAProvenanceRedacted(result.raw, result.observations);
      });
    }

    it('redacts the publisher on the MCP recent tool', async () => {
      const sharedId = await publishRunbook();
      const result = await callMcpTool(keyB, 'recent', {
        projectId: projectBId,
        limit: 20,
        scope: 'shared',
      });
      expect(result.observations.map(o => o.id)).toEqual([sharedId]);
      expectTenantAProvenanceRedacted(result.raw, result.observations);
    });

    it('projects a same-team shared row published outside the queried project', async () => {
      // Same tenant, different project. `scope: "shared"` is server-global, so the
      // project predicate does not constrain it — the row arrives through the
      // shared branch and gets the shared projection, not the owner view.
      const published = await post<{ memory: { id: string } }>('/v1/memories', keyAPublisher, {
        projectId: projectA2Id,
        content: 'shared note: the payments service rotates its own signing keys',
        metadata: PUBLISHER_METADATA,
        shared: true,
      });
      expect(published.status).toBe(201);

      const read = await post<SearchResponse>('/v1/search', keyA, {
        projectId: projectAId,
        query: 'signing keys',
        scope: 'shared',
      });
      expect(read.status).toBe(200);
      expect(read.json.observations.map(o => o.id)).toEqual([published.json.memory.id]);
      const [projected] = read.json.observations;
      expect(projected!.projectId).toBeUndefined();
      expect(projected!.serverSessionId).toBeUndefined();
      expect(projected!.teamId).toBeUndefined();
      expect(projected!.metadata).toBeUndefined();
      expect(projected!.sharedOrigin).toBeString();
      const body = JSON.stringify(read.json);
      expect(body).not.toContain(PROJECT_A2_ID);
      expect(body).not.toContain(PUBLISHER_AGENT_ID);
      expect(body).not.toContain(NESTED_MARKER);

      // Read from its own project, the very same row is the owner's view.
      const ownerRead = await post<SearchResponse>('/v1/search', keyA, {
        projectId: projectA2Id,
        query: 'signing keys',
      });
      expect(ownerRead.json.observations[0]!.projectId).toBe(projectA2Id);
      expect(ownerRead.json.observations[0]!.metadata).toMatchObject(PUBLISHER_METADATA);
    });

    // Negative control: this passes with or without the projection, by design.
    // It guards against over-redaction, not against the leak.
    it('keeps the owner\'s own shared row at full fidelity', async () => {
      const sharedId = await publishRunbook();
      const ownerRead = await post<SearchResponse>('/v1/search', keyA, {
        projectId: projectAId,
        query: 'intermediate CA',
      });
      expect(ownerRead.json.observations.map(o => o.id)).toEqual([sharedId]);
      const [own] = ownerRead.json.observations;
      expect(own!.projectId).toBe(projectAId);
      expect(own!.teamId).toBe(teamAId);
      expect(own!.metadata).toMatchObject(PUBLISHER_METADATA);
      expect(own!.sharedOrigin).toBeUndefined();
    });

    it('does not widen an MCP read through an omitted, invalid or forged scope', async () => {
      await publishRunbook();
      // 'shared' is the only value that widens; anything else narrows to the
      // caller's own tenant, and identity fields in the arguments are ignored
      // because the team binding comes from the API key.
      const narrowing: Array<Record<string, unknown>> = [
        {},
        { scope: 'all' },
        { scope: 'SHARED' },
        { scope: '*' },
        { scope: null },
        { scope: 'project', teamId: teamAId, projectId: projectBId },
        { scope: 'project', serverSessionId: 'forged', shared: true },
      ];
      for (const extra of narrowing) {
        const result = await callMcpTool(keyB, 'search', {
          projectId: projectBId,
          query: 'intermediate CA',
          ...extra,
        });
        expect(result.observations).toEqual([]);
        expect(result.raw).not.toContain(PROJECT_A_ID);
      }

      // The one value that DOES widen still hands back a projected row, so the
      // assertions above are about narrowing rather than about an empty result set.
      const widened = await callMcpTool(keyB, 'search', {
        projectId: projectBId,
        query: 'intermediate CA',
        scope: 'shared',
      });
      expectTenantAProvenanceRedacted(widened.raw, widened.observations);
    });

    it('does not turn a forged projectId into ownership of a shared row', async () => {
      // The projection's owner test uses the queried projectId, and a team-scoped
      // key may name any project. Naming the publisher's project must not promote
      // the caller to the owner view — the team comparison is what stops it.
      await publishRunbook();
      const forged = await post<SearchResponse>('/v1/search', keyB, {
        projectId: PROJECT_A_ID,
        query: 'intermediate CA',
        scope: 'shared',
        teamId: teamAId,
        serverSessionId: 'forged',
        shared: true,
      });
      expect(forged.status).toBe(200);
      // The row is reachable (it is published), but only as a projected row.
      expect(forged.json.observations).toHaveLength(1);
      for (const observation of forged.json.observations) {
        expect(observation.projectId).toBeUndefined();
        expect(observation.teamId).toBeUndefined();
        expect(observation.serverSessionId).toBeUndefined();
        expect(observation.metadata).toBeUndefined();
      }
      expect(JSON.stringify(forged.json)).not.toContain(PUBLISHER_AGENT_ID);
      expect(JSON.stringify(forged.json)).not.toContain(NESTED_MARKER);
    });

    it('does not widen a REST read through forged identity fields in the body', async () => {
      await publishRunbook();
      const forged = await post<SearchResponse>('/v1/search', keyB, {
        projectId: projectBId,
        query: 'intermediate CA',
        teamId: teamAId,
        serverSessionId: 'forged',
        shared: true,
      });
      expect(forged.status).toBe(200);
      expect(forged.json.observations).toEqual([]);

      // Same request with the real opt-in: reachable, and still projected.
      const optedIn = await post<SearchResponse>('/v1/search', keyB, {
        projectId: projectBId,
        query: 'intermediate CA',
        scope: 'shared',
        teamId: teamAId,
        shared: true,
      });
      expectTenantAProvenanceRedacted(JSON.stringify(optedIn.json), optedIn.json.observations);
    });

    it('records the shared flag on the publish audit entry', async () => {
      const sharedId = await publishRunbook();
      const privateWrite = await post<{ memory: { id: string } }>('/v1/memories', keyAPublisher, {
        projectId: projectAId,
        content: 'alpha keeps this one to itself',
      });

      const audit = await client.query<{ resource_id: string; details: { shared?: boolean } }>(
        `SELECT resource_id, details FROM audit_log
         WHERE team_id = $1 AND action = 'memory.write' ORDER BY created_at ASC`,
        [teamAId],
      );
      const bySharedFlag = new Map(audit.rows.map(r => [r.resource_id, r.details?.shared]));
      expect(bySharedFlag.get(sharedId)).toBe(true);
      expect(bySharedFlag.get(privateWrite.json.memory.id)).toBe(false);
    });
  });
});
