// SPDX-License-Identifier: Apache-2.0
//
// Compatibility tests for the remote corpus contract (docs/adr/0001).
//
// These run with no Postgres and no server: the contract is data, so it can be
// asserted directly. They exist to make three classes of change loud rather
// than silent:
//
//   1. a breaking MCP change (renamed tool, newly-required argument),
//   2. a scope regression (a read that widens instead of narrowing, a write
//      that forgets the shared grant),
//   3. a drift between the REST schemas and the MCP tool schemas.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'bun:test';
import {
  BuildCorpusRequestSchema,
  CORPUS_CONTRACT_VERSION,
  CORPUS_ERRORS,
  CORPUS_ID_PATHS,
  CORPUS_LIMIT_SELECTION,
  CORPUS_MCP_SCOPED_TOOLS,
  CORPUS_MCP_TOOLS,
  CORPUS_MEMBER_ORDER,
  CORPUS_MEMBER_PREDICATES,
  CORPUS_OPERATION_SCOPES,
  CORPUS_PATHS,
  CorpusFilterSchema,
  CorpusRefSchema,
  CorpusSummarySchema,
  CorpusTooLargeSchema,
  DEFAULT_CORPUS_MEMBER_LIMIT,
  LOCAL_STDIO_CORPUS_TOOLS,
  MAX_ARTIFACTS_PER_CORPUS,
  MAX_CORPUS_MEMBERS,
  MAX_CORPUS_TOKENS,
  MAX_HISTORY_CONTENT_CHARS,
  MAX_QUERY_HISTORY_TURNS,
  MAX_QUESTION_CHARS,
  PrimeCorpusResponseSchema,
  QueryCorpusRequestSchema,
  QueryCorpusResponseSchema,
  READ_SCOPE,
  SHARED_WRITE_SCOPE,
  SharedCorpusPrivateMembersSchema,
  CORPUS_SOURCE_PROVENANCE_FIELDS,
  CORPUS_PROVENANCE_FIELDS,
  CorpusDetailSchema,
  CorpusOwnerDetailSchema,
  CorpusOwnerSourceSchema,
  CorpusOwnerSummarySchema,
  CorpusProjectedDetailSchema,
  CorpusProjectedSourceSchema,
  CorpusProjectedSummarySchema,
  CorpusSourceSchema,
  WRITE_SCOPE,
  corpusContentDigest,
  isArtifactServable,
  parseCorpusScope,
  type CorpusMemberIdentity,
  type CorpusToolName,
} from '../../src/server/contracts/corpus-v1.js';

const TOOL_NAMES = CORPUS_MCP_TOOLS.map((t) => t.name);

function tool(name: CorpusToolName) {
  const found = CORPUS_MCP_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing from CORPUS_MCP_TOOLS`);
  return found;
}

describe('corpus contract v1 -- versioning', () => {
  it('declares version 1', () => {
    expect(CORPUS_CONTRACT_VERSION).toBe(1);
  });

  it('keeps every path under /v1 so no version bump is implied', () => {
    for (const path of Object.values(CORPUS_PATHS)) {
      expect(path.startsWith('/v1/projects/:projectId/corpora')).toBe(true);
    }
  });
});

describe('corpus contract v1 -- MCP tool surface is frozen', () => {
  // A rename is a breaking change for every skill and prompt that names a tool.
  it('exposes exactly the agreed tool names', () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      'build_corpus',
      'delete_corpus',
      'get_corpus',
      'list_corpora',
      'prime_corpus',
      'query_corpus',
      'rebuild_corpus',
      'reprime_corpus',
    ]);
  });

  // Local stdio parity (ADR D7). Read from the real local tool definitions rather
  // than a hardcoded list, so renaming a LOCAL tool fails here -- that is the
  // direction that actually breaks a skill, and a hardcoded list misses it.
  it('reuses the local stdio tool names rather than inventing remote ones', () => {
    const localSource = readFileSync(
      new URL('../../src/servers/mcp-server.ts', import.meta.url),
      'utf8',
    );
    const declared = new Set(
      [...localSource.matchAll(/name:\s*'([a-z_]*corp(?:us|ora)[a-z_]*)'/g)].map((m) => m[1]),
    );

    expect(declared.size).toBeGreaterThan(0);
    // The contract's claim about what exists locally must itself be true.
    for (const name of LOCAL_STDIO_CORPUS_TOOLS) {
      expect(declared).toContain(name);
    }
    // And every locally declared corpus tool must exist remotely.
    for (const name of declared) {
      expect(TOOL_NAMES).toContain(name);
    }
  });

  // Inlined on purpose: comparing the tool schemas against a constant in the same
  // module they are declared in is a self-consistency check, not a freeze, because
  // both get edited together.
  it('pins the required arguments of every tool', () => {
    const frozen: Record<CorpusToolName, readonly string[]> = {
      build_corpus: ['name'],
      list_corpora: [],
      get_corpus: [],
      prime_corpus: ['name'],
      query_corpus: ['question'],
      rebuild_corpus: ['name'],
      reprime_corpus: ['name'],
      delete_corpus: ['name'],
    };

    for (const name of Object.keys(frozen) as CorpusToolName[]) {
      const required = (tool(name).inputSchema.required ?? []) as readonly string[];
      expect([...required].sort()).toEqual([...frozen[name]].sort());
    }
  });

  it('lets a read tool be addressed by name or by corpusId, never both', () => {
    for (const name of ['get_corpus', 'query_corpus'] as const) {
      expect(tool(name).inputSchema.properties).toHaveProperty('corpusId');
    }

    expect(CorpusRefSchema.safeParse({ name: 'argocd' }).success).toBe(true);
    expect(CorpusRefSchema.safeParse({ corpusId: 'c_123' }).success).toBe(true);
    expect(CorpusRefSchema.safeParse({}).success).toBe(false);
    expect(CorpusRefSchema.safeParse({ name: 'argocd', corpusId: 'c_123' }).success).toBe(false);
  });

  it('never requires projectId, so one schema serves local and remote', () => {
    for (const t of CORPUS_MCP_TOOLS) {
      const required = (t.inputSchema.required ?? []) as readonly string[];
      expect(required).not.toContain('projectId');
      expect(t.inputSchema.properties).toHaveProperty('projectId');
    }
  });

  it('rejects unknown arguments on every tool', () => {
    for (const t of CORPUS_MCP_TOOLS) {
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('carries scope only where scope changes behaviour', () => {
    for (const t of CORPUS_MCP_TOOLS) {
      const hasScope = Object.hasOwn(t.inputSchema.properties, 'scope');
      const shouldHaveScope = CORPUS_MCP_SCOPED_TOOLS.includes(t.name);
      expect(hasScope).toBe(shouldHaveScope);
    }
  });

  it('documents every tool', () => {
    for (const t of CORPUS_MCP_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });
});

describe('corpus contract v1 -- scope narrowing never widens a read', () => {
  it('treats only the literal "shared" as the shared scope', () => {
    expect(parseCorpusScope('shared')).toBe('shared');
    expect(parseCorpusScope('project')).toBe('project');
  });

  it.each([undefined, null, '', 'SHARED', 'Shared', ' shared', 'all', '*', 1, true, {}])(
    'narrows %p to the caller\'s own tenant',
    (value) => {
      expect(parseCorpusScope(value)).toBe('project');
    },
  );

  it('narrows a collection-valued scope to the caller\'s own tenant', () => {
    expect(parseCorpusScope(['shared'])).toBe('project');
    expect(parseCorpusScope(['project', 'shared'])).toBe('project');
  });

  it('defaults REST reads to the tenant-only scope by leaving scope optional', () => {
    const parsed = CorpusFilterSchema.parse({});
    expect(parsed.scope).toBeUndefined();
  });

  it('rejects an unrecognised REST scope instead of narrowing silently', () => {
    expect(CorpusFilterSchema.safeParse({ scope: 'everything' }).success).toBe(false);
  });
});

describe('corpus contract v1 -- the shared-member invariant narrows, never widens', () => {
  // B3: the existing read predicate admits the caller's own PRIVATE rows once the
  // shared opt-in is on. Selecting members for a published corpus with it would
  // publish those rows. The publishable predicate must be a narrowing.
  it('keeps the publishable predicate distinct from the search read predicate', () => {
    expect(CORPUS_MEMBER_PREDICATES.publishable).not.toBe(CORPUS_MEMBER_PREDICATES.ownTenantOrShared);
    expect(CORPUS_MEMBER_PREDICATES.publishable).not.toBe(CORPUS_MEMBER_PREDICATES.ownTenant);
  });

  it('narrows the publishable predicate with an explicit shared conjunct', () => {
    expect(CORPUS_MEMBER_PREDICATES.publishable).toContain('AND observations.shared');
    // Containing the broad predicate is fine; ending there is not.
    expect(CORPUS_MEMBER_PREDICATES.publishable.endsWith('OR observations.shared)')).toBe(false);
  });

  it('leaves the plain read predicate able to see own private rows', () => {
    // Documents why it is the wrong tool for member selection, rather than
    // assuming a future reader will notice.
    expect(CORPUS_MEMBER_PREDICATES.ownTenantOrShared).toContain('OR observations.shared');
    expect(CORPUS_MEMBER_PREDICATES.ownTenantOrShared).not.toContain('AND observations.shared');
  });
});

describe('corpus contract v1 -- the content digest is the cache-correctness mechanism', () => {
  const member = (over: Partial<CorpusMemberIdentity> = {}): CorpusMemberIdentity => ({
    id: 'o1',
    updatedAtEpoch: 1000,
    shared: true,
    ...over,
  });

  it('is deterministic for the same ordered member set', () => {
    const members = [member(), member({ id: 'o2' })];
    expect(corpusContentDigest(members)).toBe(corpusContentDigest([...members]));
  });

  // B2: the observation upsert deliberately does not bump updated_at
  // (ON CONFLICT ... DO UPDATE SET updated_at = observations.updated_at), so a
  // digest over id + timestamp alone would not notice an un-share, and a foreign
  // reader would keep receiving the un-shared row through a cached artifact.
  it('changes when a member is un-shared, even with an unchanged timestamp', () => {
    const shared = [member({ shared: true })];
    const unshared = [member({ shared: false })];
    expect(corpusContentDigest(unshared)).not.toBe(corpusContentDigest(shared));
  });

  it('changes when a member is removed, added, or reordered', () => {
    const base = [member({ id: 'o1' }), member({ id: 'o2' })];
    expect(corpusContentDigest([member({ id: 'o1' })])).not.toBe(corpusContentDigest(base));
    expect(corpusContentDigest([...base, member({ id: 'o3' })])).not.toBe(corpusContentDigest(base));
    expect(corpusContentDigest([base[1], base[0]])).not.toBe(corpusContentDigest(base));
  });

  it('changes when a member is edited', () => {
    expect(corpusContentDigest([member({ updatedAtEpoch: 2000 })]))
      .not.toBe(corpusContentDigest([member({ updatedAtEpoch: 1000 })]));
  });

  // B1: corpus_artifacts holds rendered content by value, so serving the newest
  // artifact by primed_at would keep answering from deleted or un-shared rows.
  // Servability is the digest, never recency.
  it('refuses an artifact whose digest no longer matches live membership', () => {
    const built = [member({ id: 'o1' }), member({ id: 'o2' })];
    const artifact = corpusContentDigest(built);

    expect(isArtifactServable(artifact, built)).toBe(true);
    expect(isArtifactServable(artifact, [member({ id: 'o1' })])).toBe(false);
    expect(isArtifactServable(artifact, [member({ id: 'o1' }), member({ id: 'o2', shared: false })])).toBe(false);
  });

  it('bounds how many rendered copies a corpus retains', () => {
    expect(MAX_ARTIFACTS_PER_CORPUS).toBeGreaterThan(0);
    expect(MAX_ARTIFACTS_PER_CORPUS).toBeLessThanOrEqual(10);
  });
});

describe('corpus contract v1 -- read/write classification', () => {
  it('classifies queries as reads and materialisation as writes', () => {
    expect(CORPUS_OPERATION_SCOPES.query_corpus).toBe(READ_SCOPE);
    expect(CORPUS_OPERATION_SCOPES.list_corpora).toBe(READ_SCOPE);
    expect(CORPUS_OPERATION_SCOPES.get_corpus).toBe(READ_SCOPE);
    expect(CORPUS_OPERATION_SCOPES.prime_corpus).toBe(WRITE_SCOPE);
    expect(CORPUS_OPERATION_SCOPES.reprime_corpus).toBe(WRITE_SCOPE);
    expect(CORPUS_OPERATION_SCOPES.build_corpus).toBe(WRITE_SCOPE);
    expect(CORPUS_OPERATION_SCOPES.rebuild_corpus).toBe(WRITE_SCOPE);
    expect(CORPUS_OPERATION_SCOPES.delete_corpus).toBe(WRITE_SCOPE);
  });

  it('gives every tool a scope', () => {
    for (const name of TOOL_NAMES) {
      expect(CORPUS_OPERATION_SCOPES[name]).toBeTruthy();
    }
  });

  it('keeps publishing behind its own grant, distinct from plain write', () => {
    expect(SHARED_WRITE_SCOPE).toBe('memories:write:shared');
    expect(SHARED_WRITE_SCOPE).not.toBe(WRITE_SCOPE);
  });
});

describe('corpus contract v1 -- request validation', () => {
  it('accepts a minimal build', () => {
    expect(BuildCorpusRequestSchema.parse({ name: 'argocd' })).toEqual({ name: 'argocd' });
  });

  it.each(['bad name', ' padded ', 'slash/name', 'uniçode', ''])('rejects the invalid name %p', (name) => {
    expect(BuildCorpusRequestSchema.safeParse({ name }).success).toBe(false);
  });

  it('rejects a filter field the server cannot evaluate', () => {
    // `concepts` and `files` are SQLite-only columns; accepting and ignoring
    // them would silently return the wrong corpus.
    expect(CorpusFilterSchema.safeParse({ concepts: ['argocd'] }).success).toBe(false);
    expect(CorpusFilterSchema.safeParse({ files: ['a.ts'] }).success).toBe(false);
  });

  it('offers metadataMatch as the documented substitute', () => {
    expect(CorpusFilterSchema.parse({ metadataMatch: { concept: 'argocd' } }).metadataMatch).toEqual({ concept: 'argocd' });
  });

  it('caps the member limit at the documented maximum', () => {
    expect(CorpusFilterSchema.safeParse({ limit: MAX_CORPUS_MEMBERS }).success).toBe(true);
    expect(CorpusFilterSchema.safeParse({ limit: MAX_CORPUS_MEMBERS + 1 }).success).toBe(false);
    expect(DEFAULT_CORPUS_MEMBER_LIMIT).toBeLessThanOrEqual(MAX_CORPUS_MEMBERS);
  });

  it('requires a non-empty question and bounds client-carried history', () => {
    expect(QueryCorpusRequestSchema.safeParse({ question: '   ' }).success).toBe(false);
    const history = Array.from({ length: MAX_QUERY_HISTORY_TURNS + 1 }, () => ({ role: 'user' as const, content: 'q' }));
    expect(QueryCorpusRequestSchema.safeParse({ question: 'why?', history }).success).toBe(false);
  });

  // A read-scoped key must not be able to append unbounded text after the corpus
  // prefix.
  it('bounds the question and each history turn by length', () => {
    expect(QueryCorpusRequestSchema.safeParse({ question: 'q'.repeat(MAX_QUESTION_CHARS) }).success).toBe(true);
    expect(QueryCorpusRequestSchema.safeParse({ question: 'q'.repeat(MAX_QUESTION_CHARS + 1) }).success).toBe(false);
    expect(QueryCorpusRequestSchema.safeParse({
      question: 'why?',
      history: [{ role: 'user', content: 'c'.repeat(MAX_HISTORY_CONTENT_CHARS + 1) }],
    }).success).toBe(false);
  });
});

describe('corpus contract v1 -- size limits bound rows and content, and truncation is reported', () => {
  // B6: 2000 rows of arbitrary length can exceed any context window, so a build
  // could succeed and produce a corpus that can never be queried, failing later as
  // an opaque provider error far from its cause.
  it('bounds tokens as well as rows', () => {
    expect(MAX_CORPUS_TOKENS).toBeGreaterThan(0);
    const tooLarge = {
      error: 'CorpusTooLarge' as const,
      message: 'Corpus exceeds the token ceiling.',
      reason: 'tokens' as const,
      matchedCount: 120,
      tokenEstimate: MAX_CORPUS_TOKENS + 1,
      maxMembers: MAX_CORPUS_MEMBERS,
      maxTokens: MAX_CORPUS_TOKENS,
    };
    expect(CorpusTooLargeSchema.parse(tooLarge).reason).toBe('tokens');
    expect(CorpusTooLargeSchema.parse({ ...tooLarge, reason: 'members' }).reason).toBe('members');
    // The two ceilings need different client fixes, so the reason is required.
    const { reason, ...withoutReason } = tooLarge;
    expect(reason).toBe('tokens');
    expect(CorpusTooLargeSchema.safeParse(withoutReason).success).toBe(false);
  });

  // N4: rejecting at maxMembers while silently dropping rows at `limit` would be
  // the same silent truncation the contract rejects, just at a lower threshold.
  it('pins truncation and render order so neither is left to the implementation', () => {
    expect(CORPUS_LIMIT_SELECTION).toBe('newest');
    expect(CORPUS_MEMBER_ORDER).toBe('observations.created_at ASC, observations.id ASC');
  });

  it('names the disqualifying count when a published corpus would leak', () => {
    expect(SharedCorpusPrivateMembersSchema.parse({
      error: 'SharedCorpusPrivateMembers',
      message: '3 members are not shared.',
      privateMemberCount: 3,
    }).privateMemberCount).toBe(3);
    // Zero would mean the rejection was spurious.
    expect(SharedCorpusPrivateMembersSchema.safeParse({
      error: 'SharedCorpusPrivateMembers',
      message: 'none',
      privateMemberCount: 0,
    }).success).toBe(false);
  });
});

describe('corpus contract v1 -- a discovered shared corpus is addressable', () => {
  // B5: name is unique only per (team, project), so without an id-addressed route
  // scope=shared on the list surface would return corpora nobody could read.
  it('offers id-addressed read and query routes', () => {
    expect(CORPUS_ID_PATHS.item).toBe('/v1/corpora/:corpusId');
    expect(CORPUS_ID_PATHS.query).toBe('/v1/corpora/:corpusId/query');
  });

  it('keeps the id-addressed surface read-only', () => {
    const paths = Object.values(CORPUS_ID_PATHS);
    for (const mutating of ['rebuild', 'prime', 'reprime', 'delete']) {
      expect(paths.some((p) => p.includes(mutating))).toBe(false);
    }
  });
});

describe('corpus contract v1 -- response compatibility', () => {
  const summary = {
    id: 'c1',
    projectId: 'homelab',
    name: 'argocd',
    description: 'ArgoCD rollbacks',
    shared: false,
    memberScope: 'project' as const,
    foreign: false,
    stats: {
      observationCount: 3,
      matchedCount: 3,
      truncated: false,
      tokenEstimate: 1200,
      kindBreakdown: { observation: 3 },
      earliestAtEpoch: 1,
      latestAtEpoch: 2,
    },
    filterDigest: 'sha256:aaa',
    contentDigest: 'sha256:bbb',
    session_id: null,
    builtAtEpoch: 3,
    primedAtEpoch: 4,
    createdAtEpoch: 1,
    updatedAtEpoch: 5,
  };

  it('accepts a well-formed summary', () => {
    expect(CorpusSummarySchema.parse(summary).name).toBe('argocd');
  });

  // ADR D8 rule 2: nullable, not removed. A client written against the local
  // worker reads this field; returning undefined would break it.
  it('keeps session_id present and null rather than omitting it', () => {
    const { session_id, ...withoutSession } = summary;
    expect(session_id).toBeNull();
    expect(CorpusSummarySchema.safeParse(withoutSession).success).toBe(false);
    expect(CorpusSummarySchema.safeParse({ ...summary, session_id: 'sess_123' }).success).toBe(false);

    expect(PrimeCorpusResponseSchema.parse({
      corpus: summary,
      artifactId: 'a1',
      contentDigest: 'sha256:bbb',
      tokenEstimate: 1200,
      alreadyPrimed: false,
      session_id: null,
    }).session_id).toBeNull();

    expect(QueryCorpusResponseSchema.parse({
      answer: 'Roll back to the previous revision.',
      name: 'argocd',
      artifactId: 'a1',
      contentDigest: 'sha256:bbb',
      session_id: null,
    }).session_id).toBeNull();
  });

  it('reports a shared corpus and its member scope so a reader can tell provenance', () => {
    const { projectId, filterDigest, ...base } = summary;
    const foreignShared = { ...base, shared: true, memberScope: 'shared' as const, foreign: true };
    expect(CorpusSummarySchema.parse(foreignShared).foreign).toBe(true);
  });

  it('allows an empty corpus to report null date bounds', () => {
    const empty = {
      ...summary,
      contentDigest: null,
      builtAtEpoch: null,
      primedAtEpoch: null,
      stats: {
        observationCount: 0,
        matchedCount: 0,
        truncated: false,
        tokenEstimate: 0,
        kindBreakdown: {},
        earliestAtEpoch: null,
        latestAtEpoch: null,
      },
    };
    expect(CorpusSummarySchema.parse(empty).stats.observationCount).toBe(0);
  });

  it('reports truncation on the corpus rather than dropping rows quietly', () => {
    const truncated = {
      ...summary,
      stats: { ...summary.stats, observationCount: 500, matchedCount: 1500, truncated: true },
    };
    const parsed = CorpusSummarySchema.parse(truncated);
    expect(parsed.stats.truncated).toBe(true);
    expect(parsed.stats.matchedCount).toBeGreaterThan(parsed.stats.observationCount);
    // Both fields are required, so an implementation cannot omit the evidence.
    const { matchedCount, truncated: flag, ...lossyStats } = truncated.stats;
    expect(matchedCount).toBe(1500);
    expect(flag).toBe(true);
    expect(CorpusSummarySchema.safeParse({ ...summary, stats: lossyStats }).success).toBe(false);
  });

  // ADR D8 rule 1, stated honestly: the remote corpus representation is NEW, not a
  // superset of the local CorpusFile metadata. `stats` survives as a key but every
  // field inside it is renamed or retyped; `version` and `system_prompt` are gone;
  // `session_id` is the only leaf preserved by name and type. This test exists so
  // that claim cannot quietly rot back into "additive only".
  it('is a new representation, not a superset of the local CorpusFile', () => {
    const localMetadataKeys = ['version', 'created_at', 'updated_at', 'stats', 'system_prompt', 'session_id'];
    const remoteKeys = Object.keys(summary);

    // Dropped outright -- a local consumer reading either gets undefined.
    for (const dropped of ['version', 'system_prompt']) {
      expect(remoteKeys).not.toContain(dropped);
      expect(CorpusSummarySchema.safeParse({ ...summary, [dropped]: 'x' }).success).toBe(false);
    }

    // Renamed: local snake_case timestamps became *AtEpoch integers.
    for (const renamed of ['created_at', 'updated_at']) {
      expect(remoteKeys).not.toContain(renamed);
    }

    // `stats` keeps its name but shares no leaf with the local CorpusStats.
    expect(remoteKeys).toContain('stats');
    for (const key of ['observation_count', 'token_estimate', 'date_range', 'type_breakdown']) {
      expect(Object.keys(summary.stats)).not.toContain(key);
    }

    const preservedLeaves = localMetadataKeys.filter(
      (k) => remoteKeys.includes(k) && k !== 'stats',
    );
    expect(preservedLeaves).toEqual(['session_id']);
  });

  // Local prime/reprime return a top-level `name`; the remote response nests it
  // under `corpus` and is strict, so `response.name` is undefined for a local
  // client. Named here because D8 rule 2 preserves session_id but not this.
  it('does not preserve the local prime response shape beyond session_id', () => {
    const primed = PrimeCorpusResponseSchema.parse({
      corpus: summary,
      artifactId: 'a1',
      contentDigest: 'sha256:bbb',
      tokenEstimate: 1200,
      alreadyPrimed: false,
      session_id: null,
    });
    expect(primed).not.toHaveProperty('name');
    expect(primed.corpus.name).toBe('argocd');
  });
});

// The corpus row itself carries provenance too: `projectId` names the owner's
// project, and `filter`/`filterDigest` describe how they selected members.
// Condition 13 omits all three on a non-owner read, so the schema has to be able
// to express that response rather than reject it.
describe('corpus contract v1 -- owner and projected corpora are mutually exclusive', () => {
  const PROJECTED = {
    id: 'corpus-1',
    name: 'argocd',
    description: 'ArgoCD rollbacks',
    shared: true,
    memberScope: 'shared' as const,
    foreign: true,
    stats: {
      observationCount: 3,
      matchedCount: 3,
      truncated: false,
      tokenEstimate: 1200,
      kindBreakdown: { observation: 3 },
      earliestAtEpoch: 1,
      latestAtEpoch: 2,
    },
    contentDigest: 'sha256:bbb',
    session_id: null,
    builtAtEpoch: 3,
    primedAtEpoch: 4,
    createdAtEpoch: 1,
    updatedAtEpoch: 5,
  };
  const OWNED = { ...PROJECTED, foreign: false, projectId: 'homelab', filterDigest: 'sha256:aaa' };

  it('requires provenance on an owned corpus rather than accepting it as optional', () => {
    expect(CorpusOwnerSummarySchema.safeParse(OWNED).success).toBe(true);
    expect(CorpusOwnerSummarySchema.safeParse(PROJECTED).success).toBe(false);
  });

  it('accepts a projected corpus carrying no selection and no project id', () => {
    expect(CorpusProjectedSummarySchema.safeParse(PROJECTED).success).toBe(true);
  });

  it.each(CORPUS_PROVENANCE_FIELDS)('rejects %s on a projected corpus', (field) => {
    const leaked = { ...PROJECTED, [field]: field === 'filter' ? { kinds: ['insight'] } : 'leaked' };
    expect(CorpusProjectedSummarySchema.safeParse(leaked).success).toBe(false);
    expect(CorpusProjectedDetailSchema.safeParse(leaked).success).toBe(false);
  });

  // Condition 13's response was previously unrepresentable: CorpusDetailSchema
  // required `filter`, so omitting it failed the schema the server publishes.
  it('represents a condition-13 detail response instead of failing its own schema', () => {
    expect(CorpusProjectedDetailSchema.safeParse(PROJECTED).success).toBe(true);
    expect(CorpusDetailSchema.safeParse(PROJECTED).success).toBe(true);
    expect(CorpusOwnerDetailSchema.safeParse({ ...OWNED, filter: { kinds: ['insight'] } }).success).toBe(true);
    expect(CorpusOwnerDetailSchema.safeParse(OWNED).success).toBe(false);
  });

  it('admits both variants through the response union', () => {
    expect(CorpusSummarySchema.safeParse(OWNED).success).toBe(true);
    expect(CorpusSummarySchema.safeParse(PROJECTED).success).toBe(true);
  });

  // Half-projected is the shape a partial redaction produces: the union catches
  // it because the owner variant requires every provenance field together.
  it('rejects a half-projected corpus that keeps one provenance field', () => {
    expect(CorpusSummarySchema.safeParse({ ...PROJECTED, projectId: 'homelab' }).success).toBe(false);
    expect(CorpusSummarySchema.safeParse({ ...PROJECTED, filterDigest: 'sha256:aaa' }).success).toBe(false);
    expect(CorpusDetailSchema.safeParse({ ...PROJECTED, filter: { kinds: ['insight'] } }).success).toBe(false);
  });

  // A projected corpus cannot carry owner member rows: that combination is the
  // disclosure the split exists to make unstateable, not a shape to validate.
  it('refuses an owner member row inside a projected corpus', () => {
    const ownerRow = {
      id: 'obs-1',
      kind: 'insight',
      content: 'argocd syncs from the apps/ directory',
      shared: true,
      position: 0,
      createdAtEpoch: 1_700_000_000,
      projectId: 'acme-internal-pki',
      metadata: { agentId: 'agent-1' },
    };
    const { projectId, metadata, ...projectedRow } = ownerRow;
    expect(CorpusProjectedDetailSchema.safeParse({ ...PROJECTED, sources: [ownerRow] }).success).toBe(false);
    expect(CorpusProjectedDetailSchema.safeParse({ ...PROJECTED, sources: [projectedRow] }).success).toBe(true);
  });
});

// A member row's provenance crosses a tenant boundary, so the schema -- not just
// the serializer -- has to be able to say "this row was projected". Optional
// provenance could not: an over-sharing projected row would still validate.
describe('corpus contract v1 -- owner and projected member rows are mutually exclusive', () => {
  const PROJECTED = {
    id: 'obs-1',
    kind: 'insight',
    content: 'argocd syncs from the apps/ directory',
    shared: true,
    position: 0,
    createdAtEpoch: 1_700_000_000,
  };
  const OWNED = { ...PROJECTED, projectId: 'homelab', metadata: { agentId: 'agent-1' } };

  it('requires provenance on an owned row rather than accepting it as optional', () => {
    expect(CorpusOwnerSourceSchema.safeParse(OWNED).success).toBe(true);
    expect(CorpusOwnerSourceSchema.safeParse(PROJECTED).success).toBe(false);
  });

  it('accepts a projected row carrying content and citation handles only', () => {
    expect(CorpusProjectedSourceSchema.safeParse(PROJECTED).success).toBe(true);
  });

  it.each(CORPUS_SOURCE_PROVENANCE_FIELDS)('rejects %s on a projected row', (field) => {
    const leaked = { ...PROJECTED, [field]: field === 'metadata' ? { secret: true } : 'leaked' };
    expect(CorpusProjectedSourceSchema.safeParse(leaked).success).toBe(false);
  });

  // teamId and serverSessionId were never in the corpus row shape. They are
  // denied explicitly so adding them later cannot pass as an additive change.
  it('denies teamId and serverSessionId on an owned row too', () => {
    expect(CorpusOwnerSourceSchema.safeParse({ ...OWNED, teamId: 'team-1' }).success).toBe(false);
    expect(CorpusOwnerSourceSchema.safeParse({ ...OWNED, serverSessionId: 's-1' }).success).toBe(false);
  });

  it('admits both variants through the response union', () => {
    expect(CorpusSourceSchema.safeParse(OWNED).success).toBe(true);
    expect(CorpusSourceSchema.safeParse(PROJECTED).success).toBe(true);
  });

  // Half-projected is the shape a per-corpus ownership test produces when it
  // redacts one field and forgets the other.
  it('rejects a half-projected row that keeps one provenance field', () => {
    expect(CorpusSourceSchema.safeParse({ ...PROJECTED, projectId: 'homelab' }).success).toBe(false);
    expect(CorpusSourceSchema.safeParse({ ...PROJECTED, metadata: {} }).success).toBe(false);
  });
});

describe('corpus contract v1 -- error vocabulary', () => {
  it('reuses the server\'s existing error shapes', () => {
    expect(CORPUS_ERRORS.validation).toEqual({ status: 400, error: 'ValidationError' });
    expect(CORPUS_ERRORS.forbidden).toEqual({ status: 403, error: 'Forbidden' });
    expect(CORPUS_ERRORS.notFound).toEqual({ status: 404, error: 'NotFound' });
    expect(CORPUS_ERRORS.internal).toEqual({ status: 500, error: 'InternalError' });
  });

  // The shared-scope bypass is the one genuinely dangerous failure mode in this
  // design (ADR "blast radius"), so it gets a named, distinguishable code.
  it('names the shared-corpus and size rejections distinctly as 422s', () => {
    expect(CORPUS_ERRORS.sharedPrivateMembers).toEqual({ status: 422, error: 'SharedCorpusPrivateMembers' });
    expect(CORPUS_ERRORS.tooLarge).toEqual({ status: 422, error: 'CorpusTooLarge' });
    expect(CORPUS_ERRORS.sharedPrivateMembers.error).not.toBe(CORPUS_ERRORS.tooLarge.error);
  });
});
