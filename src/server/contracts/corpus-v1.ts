// SPDX-License-Identifier: Apache-2.0
//
// Remote corpus (knowledge-base) contract, version 1.
//
// Contract before implementation: this module is the single definition of the
// remote corpus request/response shapes, MCP tool schemas, error codes and
// limits. The route layer and the /v1/mcp tool surface MUST import from here
// rather than re-declaring shapes, because tests/contracts/corpus-v1.test.ts
// guards only what this module exports.
//
// Decisions and rationale: docs/adr/0001-remote-corpus-api-and-mcp-contract.md
// A future incompatible change adds corpus-v2.ts beside this file; v1 keeps
// serving.

import { z } from 'zod';

export const CORPUS_CONTRACT_VERSION = 1;

/** Unchanged from the local CorpusStore, so a name is portable between modes. */
export const CORPUS_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const CORPUS_NAME_ERROR =
  'Invalid corpus name: only alphanumeric characters, dots, hyphens, and underscores are allowed';

/**
 * Member-selection and discovery scope. `project` sees only the caller's tenant;
 * `shared` additionally sees rows other tenants published. Mirrors the
 * observation read scope from MCAA-237 — same two words, same default.
 */
export const CorpusScopeSchema = z.enum(['project', 'shared']);
export type CorpusScope = z.infer<typeof CorpusScopeSchema>;

/** Publishing a corpus needs the same extra grant as publishing an observation. */
export const SHARED_WRITE_SCOPE = 'memories:write:shared';
export const READ_SCOPE = 'memories:read';
export const WRITE_SCOPE = 'memories:write';

/**
 * A filter matching more members than this is rejected rather than truncated,
 * so a client narrows deliberately instead of silently losing knowledge. A
 * server-side constant, not part of the wire contract, so it can be raised
 * without a version bump.
 */
export const MAX_CORPUS_MEMBERS = 2000;
export const DEFAULT_CORPUS_MEMBER_LIMIT = 500;

/** Bounds for a single query; `history` is the client's own conversation state. */
export const MAX_QUERY_HISTORY_TURNS = 20;

/**
 * Filter fields the server can actually evaluate against Postgres
 * `observations`. `concepts` and `files` from the local SQLite filter have no
 * column here and map onto `metadataMatch`; anything else is rejected with
 * ValidationError rather than accepted and ignored.
 */
export const CorpusFilterSchema = z.object({
  kinds: z.array(z.string().min(1)).min(1).optional(),
  query: z.string().min(1).optional(),
  platformSource: z.string().min(1).nullable().optional(),
  dateStartEpoch: z.number().int().nonnegative().optional(),
  dateEndEpoch: z.number().int().nonnegative().optional(),
  metadataMatch: z.record(z.string(), z.unknown()).optional(),
  limit: z.number().int().positive().max(MAX_CORPUS_MEMBERS).optional(),
  scope: CorpusScopeSchema.optional(),
}).strict();
export type CorpusFilter = z.infer<typeof CorpusFilterSchema>;

export const CorpusNameSchema = z.string().min(1).regex(CORPUS_NAME_PATTERN, CORPUS_NAME_ERROR);

/** POST /v1/projects/:projectId/corpora */
export const BuildCorpusRequestSchema = z.object({
  name: CorpusNameSchema,
  description: z.string().max(2000).optional(),
  filter: CorpusFilterSchema.optional(),
  /** Publish cross-tenant. Requires SHARED_WRITE_SCOPE and shared-only members. */
  shared: z.boolean().optional(),
}).strict();
export type BuildCorpusRequest = z.infer<typeof BuildCorpusRequestSchema>;

/** POST /v1/projects/:projectId/corpora/:name/{rebuild,prime,reprime} */
export const CorpusActionRequestSchema = z.object({}).strict();

/** POST /v1/projects/:projectId/corpora/:name/query */
export const QueryCorpusRequestSchema = z.object({
  question: z.string().trim().min(1),
  /**
   * Prior turns, oldest first. The server holds no conversation state (ADR D4),
   * so multi-turn context is the client's to carry and to trim.
   */
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  }).strict()).max(MAX_QUERY_HISTORY_TURNS).optional(),
}).strict();
export type QueryCorpusRequest = z.infer<typeof QueryCorpusRequestSchema>;

/** GET /v1/projects/:projectId/corpora */
export const ListCorporaQuerySchema = z.object({
  scope: CorpusScopeSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
}).strict();

/** GET /v1/projects/:projectId/corpora/:name */
export const GetCorpusQuerySchema = z.object({
  include: z.literal('sources').optional(),
}).strict();

/**
 * Stats are derived, never client-supplied. `observationCount` is the count of
 * members still resolvable at render time, so it can fall when an observation is
 * deleted or un-shared (ADR D2).
 */
export const CorpusStatsSchema = z.object({
  observationCount: z.number().int().nonnegative(),
  tokenEstimate: z.number().int().nonnegative(),
  kindBreakdown: z.record(z.string(), z.number().int().nonnegative()),
  earliestAtEpoch: z.number().int().nonnegative().nullable(),
  latestAtEpoch: z.number().int().nonnegative().nullable(),
}).strict();

export const CorpusSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  shared: z.boolean(),
  memberScope: CorpusScopeSchema,
  /** True when the row belongs to another tenant and is visible via scope=shared. */
  foreign: z.boolean(),
  stats: CorpusStatsSchema,
  filterDigest: z.string().min(1),
  contentDigest: z.string().min(1).nullable(),
  /**
   * Always null on the remote server: there is no resumable AI session to
   * resume. Kept as a defined, nullable field rather than removed so a client
   * written against the local worker keeps parsing (ADR D8).
   */
  session_id: z.null(),
  builtAtEpoch: z.number().int().nonnegative().nullable(),
  primedAtEpoch: z.number().int().nonnegative().nullable(),
  createdAtEpoch: z.number().int().nonnegative(),
  updatedAtEpoch: z.number().int().nonnegative(),
}).strict();
export type CorpusSummary = z.infer<typeof CorpusSummarySchema>;

/**
 * Member rows, returned only for `?include=sources`. Safe on a foreign shared
 * corpus because a shared corpus may only contain already-shared observations
 * (ADR D3) — the same rows POST /v1/search { scope: 'shared' } would return.
 */
export const CorpusSourceSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: z.string().min(1),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  shared: z.boolean(),
  position: z.number().int().nonnegative(),
  createdAtEpoch: z.number().int().nonnegative(),
}).strict();

export const CorpusDetailSchema = CorpusSummarySchema.extend({
  filter: CorpusFilterSchema,
  sources: z.array(CorpusSourceSchema).optional(),
}).strict();

export const BuildCorpusResponseSchema = z.object({ corpus: CorpusDetailSchema }).strict();
export const ListCorporaResponseSchema = z.object({
  corpora: z.array(CorpusSummarySchema),
  scope: CorpusScopeSchema,
}).strict();
export const GetCorpusResponseSchema = BuildCorpusResponseSchema;

/** prime / reprime. `alreadyPrimed` is true when the digest was unchanged. */
export const PrimeCorpusResponseSchema = z.object({
  corpus: CorpusSummarySchema,
  artifactId: z.string().min(1),
  contentDigest: z.string().min(1),
  tokenEstimate: z.number().int().nonnegative(),
  alreadyPrimed: z.boolean(),
  session_id: z.null(),
}).strict();

export const QueryCorpusResponseSchema = z.object({
  answer: z.string(),
  name: z.string().min(1),
  artifactId: z.string().min(1),
  contentDigest: z.string().min(1),
  session_id: z.null(),
}).strict();

export const DeleteCorpusResponseSchema = z.object({
  deleted: z.literal(true),
  name: z.string().min(1),
}).strict();

/**
 * Error vocabulary. The first four reuse the server's existing shapes verbatim;
 * the two 422s are new to this contract. Anything else is a contract violation.
 */
export const CORPUS_ERRORS = {
  validation: { status: 400, error: 'ValidationError' },
  forbidden: { status: 403, error: 'Forbidden' },
  notFound: { status: 404, error: 'NotFound' },
  tooLarge: { status: 422, error: 'CorpusTooLarge' },
  sharedPrivateMembers: { status: 422, error: 'SharedCorpusPrivateMembers' },
  internal: { status: 500, error: 'InternalError' },
} as const;

/**
 * Anything other than the literal 'shared' means the tenant-only scope. An
 * unrecognised or forged value can only ever narrow a read, never widen it —
 * identical to parseScope() in the recall MCP server.
 */
export function parseCorpusScope(raw: unknown): CorpusScope {
  return raw === 'shared' ? 'shared' : 'project';
}

/** Canonical paths. One place to change if the prefix ever moves. */
export const CORPUS_PATHS = {
  collection: '/v1/projects/:projectId/corpora',
  item: '/v1/projects/:projectId/corpora/:name',
  rebuild: '/v1/projects/:projectId/corpora/:name/rebuild',
  prime: '/v1/projects/:projectId/corpora/:name/prime',
  query: '/v1/projects/:projectId/corpora/:name/query',
  reprime: '/v1/projects/:projectId/corpora/:name/reprime',
} as const;

/**
 * Which grant each operation needs. `prime`/`reprime` are writes because they
 * persist an artifact row; `query` is a read and never mutates user-visible
 * state, so a read-only key can ask questions but not warm a corpus.
 */
export const CORPUS_OPERATION_SCOPES = {
  build_corpus: WRITE_SCOPE,
  list_corpora: READ_SCOPE,
  get_corpus: READ_SCOPE,
  rebuild_corpus: WRITE_SCOPE,
  prime_corpus: WRITE_SCOPE,
  query_corpus: READ_SCOPE,
  reprime_corpus: WRITE_SCOPE,
  delete_corpus: WRITE_SCOPE,
} as const;

export type CorpusToolName = keyof typeof CORPUS_OPERATION_SCOPES;

const SCOPE_PROPERTY = {
  type: 'string',
  enum: ['project', 'shared'],
  description:
    "Scope. 'project' (default) uses only your own tenant's memory. "
    + "'shared' also includes knowledge other tenants published as shared.",
} as const;

const PROJECT_ID_PROPERTY = {
  type: 'string',
  description:
    'Project the corpus belongs to. Optional: defaults to the current project '
    + '(CLAUDE_MEM_PROJECT_ID in remote mode).',
} as const;

const NAME_PROPERTY = { type: 'string', description: 'Corpus name.' } as const;

/**
 * MCP tool schemas for /v1/mcp. Names match the local stdio tools exactly so a
 * skill or prompt transfers between modes unchanged (ADR D7), and `scope`
 * appears only where it changes behaviour: member selection on build_corpus and
 * discovery on list_corpora.
 */
export const CORPUS_MCP_TOOLS = [
  {
    name: 'build_corpus',
    description:
      'Build a queryable knowledge corpus from filtered observations. Pass shared: true '
      + 'to publish it cross-tenant (requires the memories:write:shared grant; the corpus '
      + 'may then contain only observations that are themselves shared).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROPERTY,
        name: NAME_PROPERTY,
        description: { type: 'string', description: 'What this corpus is about.' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'Observation kinds to include.' },
        query: { type: 'string', description: 'Full-text filter over observation content.' },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor.' },
        dateStartEpoch: { type: 'integer', description: 'Include observations created at or after this epoch-ms.' },
        dateEndEpoch: { type: 'integer', description: 'Include observations created at or before this epoch-ms.' },
        metadataMatch: { type: 'object', additionalProperties: true, description: 'Metadata keys the observation must contain.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_CORPUS_MEMBERS },
        shared: { type: 'boolean', description: 'Publish this corpus to the shared scope.' },
        scope: SCOPE_PROPERTY,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_corpora',
    description: 'List knowledge corpora with their stats. Use scope: shared to also see corpora other tenants published.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROPERTY,
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        scope: SCOPE_PROPERTY,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_corpus',
    description: 'Read one corpus: description, stats and filter. Pass includeSources to also return its member observations.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROPERTY,
        name: NAME_PROPERTY,
        includeSources: { type: 'boolean', description: 'Also return the member observations.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'prime_corpus',
    description:
      'Materialise a corpus into its rendered form so later questions are cheap. Optional — '
      + 'query_corpus renders on demand if needed. Deterministic and repeatable: priming an '
      + 'unchanged corpus is a no-op.',
    inputSchema: {
      type: 'object',
      properties: { projectId: PROJECT_ID_PROPERTY, name: NAME_PROPERTY },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_corpus',
    description:
      'Ask a question against a corpus. Each call is independent — the server keeps no '
      + 'conversation state, so pass prior turns in history if you need follow-up context.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROPERTY,
        name: NAME_PROPERTY,
        question: { type: 'string', description: 'The question to ask.' },
        history: {
          type: 'array',
          maxItems: MAX_QUERY_HISTORY_TURNS,
          description: 'Prior turns, oldest first.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['name', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'rebuild_corpus',
    description: 'Re-run a corpus\'s stored filter to pick up new observations. Does not answer questions.',
    inputSchema: {
      type: 'object',
      properties: { projectId: PROJECT_ID_PROPERTY, name: NAME_PROPERTY },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'reprime_corpus',
    description: 'Discard a corpus\'s cached rendering and rebuild it. Use after rebuild_corpus.',
    inputSchema: {
      type: 'object',
      properties: { projectId: PROJECT_ID_PROPERTY, name: NAME_PROPERTY },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_corpus',
    description: 'Delete a corpus. Its member observations are not touched.',
    inputSchema: {
      type: 'object',
      properties: { projectId: PROJECT_ID_PROPERTY, name: NAME_PROPERTY },
      required: ['name'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * Frozen required-argument set. The golden test compares against this, so
 * adding an optional argument passes while renaming a tool or promoting an
 * argument to required fails and forces the version conversation (ADR D8).
 */
export const CORPUS_MCP_REQUIRED_ARGS: Record<CorpusToolName, readonly string[]> = {
  build_corpus: ['name'],
  list_corpora: [],
  get_corpus: ['name'],
  prime_corpus: ['name'],
  query_corpus: ['name', 'question'],
  rebuild_corpus: ['name'],
  reprime_corpus: ['name'],
  delete_corpus: ['name'],
};

/** Tools that carry the scope opt-in, because for them it changes behaviour. */
export const CORPUS_MCP_SCOPED_TOOLS: readonly CorpusToolName[] = ['build_corpus', 'list_corpora'];
