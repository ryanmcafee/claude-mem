// SPDX-License-Identifier: Apache-2.0
//
// MCAA-260 — the remote corpus surface, including its tenant-isolation negative
// cases. Mirrors tests/server/runtime/tenant-isolation-routes.test.ts: two
// tenants that must never see each other, over the real HTTP surface with real
// SQL underneath, because the isolation lives in WHERE clauses.
//
// The guarantees under test are the ADR's blocking conditions:
//   - a shared corpus may contain only already-shared observations, on build
//     AND rebuild;
//   - a cross-tenant name or id is 404, never 403;
//   - both ceilings reject with the reason discriminator;
//   - a stored render is served only while its digest matches live membership.

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
import { createIsolatedSchema, dropSchema, newApiKey, poolForSchema } from '../../sdk/pg-isolation.js';
import {
  CorpusDetailSchema,
  ListCorporaResponseSchema,
  MAX_CORPUS_MEMBERS,
  PrimeCorpusResponseSchema,
  QueryCorpusResponseSchema,
} from '../../../src/server/contracts/corpus-v1.js';
import type { CorpusAnswerer, CorpusAnswerRequest } from '../../../src/server/services/CorpusAnswerer.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

interface CorpusResponse {
  corpus: {
    id: string;
    projectId: string;
    name: string;
    shared: boolean;
    memberScope: string;
    foreign: boolean;
    session_id: null;
    contentDigest: string | null;
    stats: {
      observationCount: number;
      matchedCount: number;
      truncated: boolean;
      tokenEstimate: number;
      kindBreakdown: Record<string, number>;
      earliestAtEpoch: number | null;
      latestAtEpoch: number | null;
    };
    sources?: Array<{ id: string; content: string; position: number }>;
  };
}

interface ListResponse {
  corpora: Array<{
    id: string;
    name: string;
    shared: boolean;
    foreign: boolean;
    stats: CorpusResponse['corpus']['stats'];
  }>;
  scope: string;
}

interface QueryResponse {
  answer: string;
  name: string;
  artifactId: string;
  contentDigest: string;
  session_id: null;
}

interface ErrorResponse {
  error: string;
  message?: string;
  reason?: string;
  matchedCount?: number;
  privateMemberCount?: number;
  issues?: unknown[];
}

describe('MCAA-260 — remote corpus routes', () => {
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

  let teamAId: string;
  let teamBId: string;
  let projectAId: string;
  let projectBId: string;
  let keyA: string;
  let keyB: string;
  let keyAPublisher: string;
  let keyAReadOnly: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];
  let answerCalls: CorpusAnswerRequest[] = [];

  // A stub answerer: query_corpus is the one corpus operation that calls a
  // model, and what matters here is which corpus text reached it.
  const answerer: CorpusAnswerer = {
    answer: async (request) => {
      answerCalls.push(request);
      return `answered from ${request.rendered.length} characters of corpus`;
    },
  };

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    key: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json().catch(() => ({})) as T;
    return { status: response.status, json };
  }

  async function writeMemory(key: string, projectId: string, content: string, options: {
    shared?: boolean;
    kind?: string;
    metadata?: Record<string, unknown>;
  } = {}): Promise<string> {
    const created = await request<{ memory: { id: string } }>('POST', '/v1/memories', key, {
      projectId,
      content,
      ...options,
    });
    expect(created.status).toBe(201);
    return created.json.memory.id;
  }

  function corporaPath(projectId: string, suffix = ''): string {
    return `/v1/projects/${projectId}/corpora${suffix}`;
  }

  beforeEach(async () => {
    answerCalls = [];
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_mcaa260_corpus');
    pool = poolForSchema(testDatabaseUrl, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const teamA = await storage.teams.create({ name: 'tenant-a' });
    const teamB = await storage.teams.create({ name: 'tenant-b' });
    teamAId = teamA.id;
    teamBId = teamB.id;
    // Same project NAME on both sides, so a corpus name collision is real.
    projectAId = (await storage.projects.create({ teamId: teamAId, name: 'homelab' })).id;
    projectBId = (await storage.projects.create({ teamId: teamBId, name: 'homelab' })).id;

    const mint = async (teamId: string, actorId: string, scopes: string[]): Promise<string> => {
      const material = newApiKey();
      await storage.auth.createApiKey({
        keyHash: material.hash,
        teamId,
        projectId: null,
        actorId,
        scopes,
      });
      return material.raw;
    };
    keyA = await mint(teamAId, 'system:mcaa260-a', ['memories:read', 'memories:write']);
    keyB = await mint(teamBId, 'system:mcaa260-b', ['memories:read', 'memories:write']);
    keyAPublisher = await mint(teamAId, 'system:mcaa260-a-publisher', ['memories:read', 'memories:write', 'memories:write:shared']);
    keyAReadOnly = await mint(teamAId, 'system:mcaa260-a-readonly', ['memories:read']);

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
      corpusAnswerer: answerer,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch { /* server may already be down */ }
    client.release();
    await pool.end();
    await dropSchema(testDatabaseUrl, schemaName);
    for (const spy of loggerSpies) spy.mockRestore();
    loggerSpies = [];
  });

  it('builds a corpus and answers a question with no local worker or database', async () => {
    await writeMemory(keyA, projectAId, 'the rollback procedure drains the node first');
    await writeMemory(keyA, projectAId, 'the kernel upgrade needs a reboot window');

    const built = await request<CorpusResponse>('POST', corporaPath(projectAId), keyA, {
      name: 'ops-runbook',
      description: 'operational knowledge',
    });
    expect(built.status).toBe(201);
    // The contract schemas are strict, so this fails on an extra, missing or
    // retyped field — the implementation cannot drift from corpus-v1.ts.
    expect(CorpusDetailSchema.safeParse(built.json.corpus).success).toBe(true);
    expect(built.json.corpus.stats.observationCount).toBe(2);
    expect(built.json.corpus.stats.matchedCount).toBe(2);
    expect(built.json.corpus.stats.truncated).toBe(false);
    // Nullable, not removed: this server holds no resumable session.
    expect(built.json.corpus.session_id).toBeNull();

    const answered = await request<QueryResponse>('POST', corporaPath(projectAId, '/ops-runbook/query'), keyA, {
      question: 'what happens before a kernel upgrade?',
    });
    expect(answered.status).toBe(200);
    expect(QueryCorpusResponseSchema.safeParse(answered.json).success).toBe(true);
    expect(answered.json.name).toBe('ops-runbook');
    expect(answered.json.session_id).toBeNull();
    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0]!.rendered).toContain('the rollback procedure drains the node first');
  });

  it('is idempotent: rebuilding in place returns 200 and one corpus', async () => {
    await writeMemory(keyA, projectAId, 'first note');
    const first = await request<CorpusResponse>('POST', corporaPath(projectAId), keyA, { name: 'notes' });
    expect(first.status).toBe(201);
    const second = await request<CorpusResponse>('POST', corporaPath(projectAId), keyA, { name: 'notes' });
    expect(second.status).toBe(200);
    expect(second.json.corpus.id).toBe(first.json.corpus.id);

    const listed = await request<ListResponse>('GET', corporaPath(projectAId), keyA);
    expect(ListCorporaResponseSchema.safeParse(listed.json).success).toBe(true);
    expect(listed.json.corpora.map(corpus => corpus.name)).toEqual(['notes']);
  });

  it('keeps two tenants\' corpora mutually invisible', async () => {
    await writeMemory(keyA, projectAId, 'alpha incident postmortem');
    await writeMemory(keyB, projectBId, 'bravo incident postmortem');
    await request('POST', corporaPath(projectAId), keyA, { name: 'incidents' });
    await request('POST', corporaPath(projectBId), keyB, { name: 'incidents' });

    // Same name, same project name, different tenants: each sees only its own.
    const listA = await request<ListResponse>('GET', corporaPath(projectAId), keyA);
    const listB = await request<ListResponse>('GET', corporaPath(projectBId), keyB);
    expect(listA.json.corpora).toHaveLength(1);
    expect(listB.json.corpora).toHaveLength(1);
    expect(listA.json.corpora[0]!.id).not.toBe(listB.json.corpora[0]!.id);

    const detailA = await request<CorpusResponse>('GET', corporaPath(projectAId, '/incidents?include=sources'), keyA);
    expect(detailA.json.corpus.sources!.map(source => source.content)).toEqual(['alpha incident postmortem']);
  });

  it('answers 404, never 403, when a tenant forges the other tenant\'s project or name', async () => {
    await writeMemory(keyB, projectBId, 'bravo credential rotation plan');
    const builtB = await request<CorpusResponse>('POST', corporaPath(projectBId), keyB, { name: 'secrets' });
    expect(builtB.status).toBe(201);

    // A's key with B's projectId: the team comes from the key, so the project
    // does not exist as far as A is concerned.
    const forgedRead = await request<ErrorResponse>('GET', corporaPath(projectBId, '/secrets'), keyA);
    expect(forgedRead.status).toBe(404);
    expect(forgedRead.json.error).toBe('NotFound');

    const forgedQuery = await request<ErrorResponse>('POST', corporaPath(projectBId, '/secrets/query'), keyA, {
      question: 'what are the credentials?',
    });
    expect(forgedQuery.status).toBe(404);
    expect(answerCalls).toHaveLength(0);

    const forgedDelete = await request<ErrorResponse>('DELETE', corporaPath(projectBId, '/secrets'), keyA);
    expect(forgedDelete.status).toBe(404);

    // And the id-addressed route does not confirm the id either.
    const forgedById = await request<ErrorResponse>('GET', `/v1/corpora/${builtB.json.corpus.id}`, keyA);
    expect(forgedById.status).toBe(404);
    expect(forgedById.json.error).toBe('NotFound');

    // B's corpus is untouched by all of that.
    const stillThere = await request<CorpusResponse>('GET', corporaPath(projectBId, '/secrets'), keyB);
    expect(stillThere.status).toBe(200);
  });

  it('refuses to publish a corpus over private observations, on build and on rebuild', async () => {
    const privateId = await writeMemory(keyAPublisher, projectAId, 'alpha private deployment secret');
    await writeMemory(keyAPublisher, projectAId, 'alpha published deployment note', { shared: true });

    const attempt = await request<ErrorResponse>('POST', corporaPath(projectAId), keyAPublisher, {
      name: 'published',
      shared: true,
    });
    expect(attempt.status).toBe(422);
    expect(attempt.json.error).toBe('SharedCorpusPrivateMembers');
    expect(attempt.json.privateMemberCount).toBe(1);

    // Nothing was published, so B still sees nothing.
    const listB = await request<ListResponse>('GET', `${corporaPath(projectBId)}?scope=shared`, keyB);
    expect(listB.json.corpora).toEqual([]);

    // Narrow the filter so only the shared row qualifies, and it publishes.
    const published = await request<CorpusResponse>('POST', corporaPath(projectAId), keyAPublisher, {
      name: 'published',
      shared: true,
      filter: { query: 'published' },
    });
    expect(published.status).toBe(201);
    expect(published.json.corpus.shared).toBe(true);

    // Now widen the stored filter by un-narrowing it through a fresh build with
    // the same name: the private row qualifies again and the rebuild is refused.
    const smuggle = await request<ErrorResponse>('POST', corporaPath(projectAId), keyAPublisher, {
      name: 'published',
      shared: true,
    });
    expect(smuggle.status).toBe(422);
    expect(smuggle.json.error).toBe('SharedCorpusPrivateMembers');

    // The published corpus is unchanged and still excludes the private row.
    const detail = await request<CorpusResponse>('GET', corporaPath(projectAId, '/published?include=sources'), keyAPublisher);
    expect(detail.json.corpus.sources!.map(source => source.id)).not.toContain(privateId);

    // And the rebuild endpoint re-validates too: a new private row that the
    // stored filter now matches is refused rather than smuggled in.
    await writeMemory(keyAPublisher, projectAId, 'newly published-looking but private note');
    const rebuilt = await request<ErrorResponse>('POST', corporaPath(projectAId, '/published/rebuild'), keyAPublisher, {});
    expect(rebuilt.status).toBe(422);
    expect(rebuilt.json.error).toBe('SharedCorpusPrivateMembers');

    const afterRebuild = await request<CorpusResponse>('GET', corporaPath(projectAId, '/published?include=sources'), keyAPublisher);
    expect(afterRebuild.json.corpus.sources!.map(source => source.content))
      .toEqual(['alpha published deployment note']);
  });

  it('requires the shared-write grant to publish a corpus', async () => {
    await writeMemory(keyA, projectAId, 'alpha note');
    const attempt = await request<ErrorResponse>('POST', corporaPath(projectAId), keyA, {
      name: 'published',
      shared: true,
    });
    expect(attempt.status).toBe(403);
    expect(attempt.json.message).toContain('memories:write:shared');

    // The guard runs before the build: no corpus row exists.
    const listed = await request<ListResponse>('GET', corporaPath(projectAId), keyA);
    expect(listed.json.corpora).toEqual([]);
  });

  it('lets another tenant discover, read and query a published corpus by id', async () => {
    await writeMemory(keyAPublisher, projectAId, 'shared knowledge: rollbacks use the previous ArgoCD revision', { shared: true });
    const published = await request<CorpusResponse>('POST', corporaPath(projectAId), keyAPublisher, {
      name: 'argocd',
      shared: true,
      filter: { scope: 'project' },
    });
    expect(published.status).toBe(201);
    const corpusId = published.json.corpus.id;

    // Default scope hides it; the opt-in reveals it.
    const defaultScope = await request<ListResponse>('GET', corporaPath(projectBId), keyB);
    expect(defaultScope.json.corpora).toEqual([]);

    const sharedScope = await request<ListResponse>('GET', `${corporaPath(projectBId)}?scope=shared`, keyB);
    expect(sharedScope.json.corpora.map(corpus => corpus.id)).toEqual([corpusId]);
    expect(sharedScope.json.corpora[0]!.foreign).toBe(true);

    // A name is not a cross-tenant identity, so the id route is how B reads it.
    const byName = await request<ErrorResponse>('GET', corporaPath(projectBId, '/argocd'), keyB);
    expect(byName.status).toBe(404);

    const byId = await request<CorpusResponse>('GET', `/v1/corpora/${corpusId}?include=sources`, keyB);
    expect(byId.status).toBe(200);
    expect(byId.json.corpus.foreign).toBe(true);
    // Safe by the shared-member invariant: these are rows a shared search would
    // already return.
    expect(byId.json.corpus.sources!.every(source => source.content.includes('shared knowledge'))).toBe(true);

    const queried = await request<QueryResponse>('POST', `/v1/corpora/${corpusId}/query`, keyB, {
      question: 'how do rollbacks work?',
    });
    expect(queried.status).toBe(200);
    expect(queried.json.session_id).toBeNull();
  });

  it('publishes corpus content to another tenant without its provenance', async () => {
    await writeMemory(keyAPublisher, projectAId, 'shared knowledge: drain the node before rollback', {
      shared: true,
      metadata: { agentId: 'agent-alpha-7', sourceAdapter: 'claude' },
    });
    const published = await request<CorpusResponse>('POST', corporaPath(projectAId), keyAPublisher, {
      name: 'rollbacks',
      shared: true,
      filter: { scope: 'project' },
    });
    expect(published.status).toBe(201);
    const corpusId = published.json.corpus.id;

    // The owner still sees everything, including where each row came from.
    const owned = await request<CorpusResponse>(
      'GET', corporaPath(projectAId, '/rollbacks?include=sources'), keyAPublisher,
    );
    expect(owned.json.corpus.projectId).toBe(projectAId);
    expect(owned.json.corpus.sources![0]!.metadata).toMatchObject({ agentId: 'agent-alpha-7' });

    const byId = await request<CorpusResponse>('GET', `/v1/corpora/${corpusId}?include=sources`, keyB);
    expect(byId.status).toBe(200);
    // Content crosses the tenant boundary; provenance does not.
    expect(byId.json.corpus.sources![0]!.content).toContain('drain the node before rollback');
    expect(byId.json.corpus.sources![0]).not.toHaveProperty('projectId');
    expect(byId.json.corpus.sources![0]).not.toHaveProperty('metadata');
    expect(byId.json.corpus).not.toHaveProperty('projectId');
    expect(JSON.stringify(byId.json)).not.toContain('agent-alpha-7');
    expect(JSON.stringify(byId.json)).not.toContain(projectAId);
  });

  it('serves a non-owner no statistic that spans a removed member', async () => {
    const doomedId = await writeMemory(keyAPublisher, projectAId, 'shared knowledge: the step that gets retired', {
      shared: true,
      kind: 'runbook',
    });
    await writeMemory(keyAPublisher, projectAId, 'shared knowledge: the step that stays', {
      shared: true,
      kind: 'runbook',
    });
    const published = await request<CorpusResponse>('POST', corporaPath(projectAId), keyAPublisher, {
      name: 'retirement',
      shared: true,
      filter: { scope: 'project' },
    });
    expect(published.status).toBe(201);
    const corpusId = published.json.corpus.id;

    const readById = (): Promise<{ status: number; json: CorpusResponse }> =>
      request<CorpusResponse>('GET', `/v1/corpora/${corpusId}`, keyB);
    const listShared = (): Promise<{ status: number; json: ListResponse }> =>
      request<ListResponse>('GET', `${corporaPath(projectBId)}?scope=shared`, keyB);

    const before = await readById();
    expect(before.status).toBe(200);
    expect(before.json.corpus.stats.observationCount).toBe(2);
    const beforeList = await listShared();
    expect(beforeList.json.corpora[0]!.stats.observationCount).toBe(2);

    // The owner retires one member. Tenant B holds no claim on a row that is no
    // longer a member, so nothing it can observe may still describe that row.
    const deleted = await request('DELETE', `/v1/memories/${doomedId}`, keyAPublisher);
    expect(deleted.status).toBe(200);

    const after = await readById();
    expect(after.json.corpus.stats.observationCount).toBe(1);
    expect(after.json.corpus.stats.kindBreakdown).toEqual({ runbook: 1 });
    // matchedCount and truncated would otherwise report the owner's selection:
    // how many rows their filter reached, including the retired one.
    expect(after.json.corpus.stats.matchedCount).toBe(1);
    expect(after.json.corpus.stats.truncated).toBe(false);
    expect(after.json.corpus.stats.tokenEstimate)
      .toBeLessThan(before.json.corpus.stats.tokenEstimate);
    // The date range collapses onto the one surviving member rather than still
    // spanning the retired row's timestamp.
    expect(after.json.corpus.stats.earliestAtEpoch).toBe(after.json.corpus.stats.latestAtEpoch);
    expect(after.json.corpus.stats.earliestAtEpoch)
      .toBeGreaterThanOrEqual(before.json.corpus.stats.earliestAtEpoch!);

    // The whole point of condition 21: the only values that moved are the ones
    // describing the membership tenant B can see now.
    const changedFields = Object.keys(after.json.corpus)
      .filter(field => JSON.stringify(after.json.corpus[field as keyof CorpusResponse['corpus']])
        !== JSON.stringify(before.json.corpus[field as keyof CorpusResponse['corpus']]));
    expect(changedFields.sort()).toEqual(['contentDigest', 'stats']);

    const afterList = await listShared();
    expect(afterList.json.corpora[0]!.stats.observationCount).toBe(1);
    expect(afterList.json.corpora[0]!.stats.matchedCount).toBe(1);
    expect(afterList.json.corpora[0]!.stats.latestAtEpoch)
      .toBe(after.json.corpus.stats.latestAtEpoch);
    expect(ListCorporaResponseSchema.safeParse(afterList.json).success).toBe(true);

    // The owner is a different reader: their own numbers still report the
    // selection their filter made, which is theirs to see.
    const owner = await request<CorpusResponse>('GET', corporaPath(projectAId, '/retirement'), keyAPublisher);
    expect(owner.json.corpus.stats.matchedCount).toBe(2);
  });

  it('never serves an owner-primed render to a foreign reader', async () => {
    await writeMemory(keyAPublisher, projectAId, 'shared knowledge: restart the operator last', {
      shared: true,
      metadata: { agentId: 'agent-alpha-9' },
    });
    const published = await request<CorpusResponse>('POST', corporaPath(projectAId), keyAPublisher, {
      name: 'operator',
      shared: true,
      filter: { scope: 'project' },
    });
    const corpusId = published.json.corpus.id;

    // Priming caches a render keyed on membership alone. Without a viewer
    // dimension that cached copy -- which carries metadata -- would be handed
    // straight to tenant B on the next query.
    const primed = await request('POST', corporaPath(projectAId, '/operator/prime'), keyAPublisher, {});
    expect(primed.status).toBe(200);

    const queried = await request<QueryResponse>('POST', `/v1/corpora/${corpusId}/query`, keyB, {
      question: 'what restarts last?',
    });
    expect(queried.status).toBe(200);

    const foreignRender = answerCalls.at(-1)!.rendered;
    expect(foreignRender).toContain('restart the operator last');
    expect(foreignRender).not.toContain('agent-alpha-9');
    expect(foreignRender).not.toContain('**Metadata:**');
  });

  it('never exposes a private corpus through the id-addressed route', async () => {
    await writeMemory(keyA, projectAId, 'alpha private runbook');
    const privateCorpus = await request<CorpusResponse>('POST', corporaPath(projectAId), keyA, { name: 'private' });
    expect(privateCorpus.status).toBe(201);

    const probe = await request<ErrorResponse>('GET', `/v1/corpora/${privateCorpus.json.corpus.id}`, keyB);
    expect(probe.status).toBe(404);

    const query = await request<ErrorResponse>('POST', `/v1/corpora/${privateCorpus.json.corpus.id}/query`, keyB, {
      question: 'what is in the runbook?',
    });
    expect(query.status).toBe(404);
    expect(answerCalls).toHaveLength(0);
  });

  it('drops a deleted observation from the corpus and refuses to answer from the stale render', async () => {
    const doomedId = await writeMemory(keyA, projectAId, 'a fact that will be forgotten');
    await writeMemory(keyA, projectAId, 'a fact that stays');
    await request('POST', corporaPath(projectAId), keyA, { name: 'facts' });

    const primed = await request<{ contentDigest: string; alreadyPrimed: boolean }>(
      'POST', corporaPath(projectAId, '/facts/prime'), keyA, {},
    );
    expect(primed.status).toBe(200);
    expect(PrimeCorpusResponseSchema.safeParse(primed.json).success).toBe(true);
    const digestBefore = primed.json.contentDigest;

    // Priming is deterministic, so priming again is a no-op.
    const again = await request<{ contentDigest: string; alreadyPrimed: boolean }>(
      'POST', corporaPath(projectAId, '/facts/prime'), keyA, {},
    );
    expect(again.json.alreadyPrimed).toBe(true);
    expect(again.json.contentDigest).toBe(digestBefore);

    const deleted = await request('DELETE', `/v1/memories/${doomedId}`, keyA);
    expect(deleted.status).toBe(200);

    const answered = await request<QueryResponse>('POST', corporaPath(projectAId, '/facts/query'), keyA, {
      question: 'what facts are there?',
    });
    expect(answered.status).toBe(200);
    // The digest moved with membership, and the render handed to the model no
    // longer contains the deleted observation.
    expect(answered.json.contentDigest).not.toBe(digestBefore);
    expect(answerCalls.at(-1)!.rendered).not.toContain('a fact that will be forgotten');
    expect(answerCalls.at(-1)!.rendered).toContain('a fact that stays');

    const detail = await request<CorpusResponse>('GET', corporaPath(projectAId, '/facts'), keyA);
    expect(detail.json.corpus.stats.observationCount).toBe(1);
  });

  it('reports truncation instead of silently dropping members', async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeMemory(keyA, projectAId, `observation number ${index}`);
    }
    const built = await request<CorpusResponse>('POST', corporaPath(projectAId), keyA, {
      name: 'capped',
      filter: { limit: 2 },
    });
    expect(built.status).toBe(201);
    expect(built.json.corpus.stats.matchedCount).toBe(5);
    expect(built.json.corpus.stats.observationCount).toBe(2);
    expect(built.json.corpus.stats.truncated).toBe(true);
  });

  it('rejects a filter field the server cannot evaluate rather than ignoring it', async () => {
    const rejected = await request<ErrorResponse>('POST', corporaPath(projectAId), keyA, {
      name: 'bad-filter',
      filter: { concepts: ['kubernetes'] },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toBe('ValidationError');
  });

  it('rejects an unrecognised scope rather than guessing', async () => {
    for (const scope of ['all', 'global', 'SHARED', '*']) {
      const response = await request<ErrorResponse>('GET', `${corporaPath(projectAId)}?scope=${encodeURIComponent(scope)}`, keyA);
      expect(response.status).toBe(400);
      expect(response.json.error).toBe('ValidationError');
    }
  });

  it('rejects an invalid corpus name with the local validation rule', async () => {
    const response = await request<ErrorResponse>('POST', corporaPath(projectAId), keyA, { name: 'not a valid name' });
    expect(response.status).toBe(400);
    expect(response.json.error).toBe('ValidationError');
  });

  it('caps the member ceiling above the limit zod accepts, with the reason discriminator', async () => {
    // The maxMembers rejection is only reachable when matches are counted
    // BEFORE `limit`; this asserts the shape of the rejection it produces.
    expect(MAX_CORPUS_MEMBERS).toBe(2000);
    const overCap = await request<ErrorResponse>('POST', corporaPath(projectAId), keyA, {
      name: 'too-big',
      filter: { limit: MAX_CORPUS_MEMBERS + 1 },
    });
    expect(overCap.status).toBe(400);
    expect(overCap.json.error).toBe('ValidationError');
  });

  it('lets a read-only key query but not prime', async () => {
    await writeMemory(keyA, projectAId, 'a note to ask about');
    await request('POST', corporaPath(projectAId), keyA, { name: 'readable' });

    const primed = await request<ErrorResponse>('POST', corporaPath(projectAId, '/readable/prime'), keyAReadOnly, {});
    expect(primed.status).toBe(403);

    // query renders on demand, so a read-only key never meets "not primed".
    const answered = await request<QueryResponse>('POST', corporaPath(projectAId, '/readable/query'), keyAReadOnly, {
      question: 'what note is there?',
    });
    expect(answered.status).toBe(200);
    expect(answered.json.artifactId).not.toBe('');
  });

  it('deletes a corpus without touching its member observations', async () => {
    const memoryId = await writeMemory(keyA, projectAId, 'a memory that outlives its corpus');
    await request('POST', corporaPath(projectAId), keyA, { name: 'temporary' });

    const deleted = await request<{ deleted: boolean; name: string }>('DELETE', corporaPath(projectAId, '/temporary'), keyA);
    expect(deleted.status).toBe(200);
    expect(deleted.json).toEqual({ deleted: true, name: 'temporary' });

    const gone = await request<ErrorResponse>('GET', corporaPath(projectAId, '/temporary'), keyA);
    expect(gone.status).toBe(404);

    const memoryStillThere = await request<{ observations: Array<{ id: string }> }>('POST', '/v1/search', keyA, {
      projectId: projectAId,
      query: 'outlives',
    });
    expect(memoryStillThere.json.observations.map(observation => observation.id)).toEqual([memoryId]);
  });

  it('rejects anonymous and unknown keys on every corpus route', async () => {
    const anonymous = await fetch(`http://127.0.0.1:${port}${corporaPath(projectAId)}`);
    expect(anonymous.status).toBe(401);

    const forged = await request<ErrorResponse>('GET', corporaPath(projectAId), 'cm_not_a_real_key');
    expect(forged.status).toBe(403);
  });
});
