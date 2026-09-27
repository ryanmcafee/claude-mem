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

import { describe, it, expect } from 'bun:test';
import {
  BuildCorpusRequestSchema,
  CORPUS_CONTRACT_VERSION,
  CORPUS_ERRORS,
  CORPUS_MCP_REQUIRED_ARGS,
  CORPUS_MCP_SCOPED_TOOLS,
  CORPUS_MCP_TOOLS,
  CORPUS_OPERATION_SCOPES,
  CORPUS_PATHS,
  CorpusFilterSchema,
  CorpusSummarySchema,
  DEFAULT_CORPUS_MEMBER_LIMIT,
  MAX_CORPUS_MEMBERS,
  MAX_QUERY_HISTORY_TURNS,
  PrimeCorpusResponseSchema,
  QueryCorpusRequestSchema,
  QueryCorpusResponseSchema,
  READ_SCOPE,
  SHARED_WRITE_SCOPE,
  WRITE_SCOPE,
  parseCorpusScope,
  type CorpusToolName,
} from '../../src/server/contracts/corpus-v1.js';

const TOOL_NAMES = CORPUS_MCP_TOOLS.map((t) => t.name);

function tool(name: CorpusToolName) {
  const found = CORPUS_MCP_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing from CORPUS_MCP_TOOLS`);
  return found;
}

describe('corpus contract v1 — versioning', () => {
  it('declares version 1', () => {
    expect(CORPUS_CONTRACT_VERSION).toBe(1);
  });

  it('keeps every path under /v1 so no version bump is implied', () => {
    for (const path of Object.values(CORPUS_PATHS)) {
      expect(path.startsWith('/v1/projects/:projectId/corpora')).toBe(true);
    }
  });
});

describe('corpus contract v1 — MCP tool surface is frozen', () => {
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

  // Local stdio parity (ADR D7): these six names already exist locally and must
  // not diverge remotely.
  it('reuses the local stdio tool names rather than inventing remote ones', () => {
    for (const shared of ['build_corpus', 'list_corpora', 'prime_corpus', 'query_corpus', 'rebuild_corpus', 'reprime_corpus']) {
      expect(TOOL_NAMES).toContain(shared);
    }
  });

  it('pins the required arguments of every tool', () => {
    for (const name of Object.keys(CORPUS_MCP_REQUIRED_ARGS) as CorpusToolName[]) {
      const required = (tool(name).inputSchema.required ?? []) as readonly string[];
      expect([...required].sort()).toEqual([...CORPUS_MCP_REQUIRED_ARGS[name]].sort());
    }
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

describe('corpus contract v1 — scope narrowing never widens a read', () => {
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

describe('corpus contract v1 — read/write classification', () => {
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

describe('corpus contract v1 — request validation', () => {
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
});

describe('corpus contract v1 — response compatibility', () => {
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
    const foreignShared = { ...summary, shared: true, memberScope: 'shared' as const, foreign: true };
    expect(CorpusSummarySchema.parse(foreignShared).foreign).toBe(true);
  });

  it('allows an empty corpus to report null date bounds', () => {
    const empty = {
      ...summary,
      contentDigest: null,
      builtAtEpoch: null,
      primedAtEpoch: null,
      stats: { observationCount: 0, tokenEstimate: 0, kindBreakdown: {}, earliestAtEpoch: null, latestAtEpoch: null },
    };
    expect(CorpusSummarySchema.parse(empty).stats.observationCount).toBe(0);
  });
});

describe('corpus contract v1 — error vocabulary', () => {
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
