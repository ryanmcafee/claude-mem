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

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CORPUS_CONTRACT_VERSION = 1;

/** Unchanged from the local CorpusStore, so a name is portable between modes. */
export const CORPUS_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const CORPUS_NAME_ERROR =
  'Invalid corpus name: only alphanumeric characters, dots, hyphens, and underscores are allowed';

/**
 * Candidate-row breadth for member selection and for corpus discovery.
 * `project` sees only the caller's tenant; `shared` additionally sees rows other
 * tenants published. Mirrors the observation read scope from MCAA-237 -- same two
 * words, same default.
 *
 * This is breadth only. It is NOT the rule that keeps a published corpus safe;
 * see CORPUS_MEMBER_PREDICATES.publishable, which narrows instead of widening.
 */
export const CorpusScopeSchema = z.enum(['project', 'shared']);
export type CorpusScope = z.infer<typeof CorpusScopeSchema>;

/**
 * The three distinct member predicates, named so an implementer cannot reach for
 * the wrong one. `ownTenantOrShared` is the existing read predicate from
 * PostgresObservationRepository.search() -- note it admits the caller's own
 * PRIVATE rows, so it must never be used on its own to select members for a
 * published corpus. `publishable` is a third predicate, not a scope: it adds a
 * narrowing `AND observations.shared` conjunct (ADR D3).
 */
export const CORPUS_MEMBER_PREDICATES = {
  ownTenant:
    '(observations.project_id = $projectId AND observations.team_id = $teamId)',
  ownTenantOrShared:
    '((observations.project_id = $projectId AND observations.team_id = $teamId) OR observations.shared)',
  publishable:
    '(((observations.project_id = $projectId AND observations.team_id = $teamId) OR observations.shared) AND observations.shared)',
} as const;

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

/**
 * Rows are not tokens: 2000 short observations and 2000 long ones are different
 * orders of magnitude. Without a token ceiling a build can succeed and produce a
 * corpus that can never be queried, failing later as an opaque provider 400 far
 * from its cause. Checked at build/rebuild, where token_estimate is computed
 * anyway and a loud failure is affordable.
 */
export const MAX_CORPUS_TOKENS = 400_000;

/**
 * Every membership change mints a new content digest, and a query-on-miss can
 * mint one from a read-only key, so renders accumulate. Keep this many newest
 * artifacts per corpus and delete superseded digests; this also bounds how long
 * a rendered copy of a since-deleted observation can linger.
 */
export const MAX_ARTIFACTS_PER_CORPUS = 3;

/** Bounds for a single query; `history` is the client's own conversation state. */
export const MAX_QUERY_HISTORY_TURNS = 20;
export const MAX_QUESTION_CHARS = 4000;
export const MAX_HISTORY_CONTENT_CHARS = 8000;

/**
 * Render order, pinned because it is the digest input and therefore the cache
 * key. Derived from the observation columns rather than a stored `position`, so
 * it cannot drift or duplicate.
 */
export const CORPUS_MEMBER_ORDER = 'observations.created_at ASC, observations.id ASC' as const;

/**
 * What `limit` does when a filter matches more rows than it. Truncation keeps the
 * NEWEST matches (recent knowledge is the useful end) and renders them
 * oldest-first per CORPUS_MEMBER_ORDER. It is never silent: `matchedCount` and
 * `truncated` are reported on the corpus. Above MAX_CORPUS_MEMBERS the build is
 * rejected instead, so matches MUST be counted before `limit` is applied.
 */
export const CORPUS_LIMIT_SELECTION = 'newest' as const;

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

/**
 * Digest input for one member. `shared` is part of the identity on purpose: the
 * observation upsert deliberately does NOT bump `updated_at`
 * (`ON CONFLICT ... DO UPDATE SET updated_at = observations.updated_at`), so a
 * digest over id + timestamp alone would not change when a row is un-shared, and
 * a cached artifact would keep serving that row's content to a foreign reader.
 */
export interface CorpusMemberIdentity {
  id: string;
  updatedAtEpoch: number;
  shared: boolean;
}

/**
 * The content digest of an ordered member set. Deterministic and order-sensitive,
 * because render order is part of what was rendered.
 *
 * This is the whole cache-correctness mechanism (ADR D2/D4): `query` MUST
 * recompute this from live membership on every request and MUST refuse to serve
 * a stored artifact whose digest differs, rather than serving the newest
 * artifact by `primed_at`.
 */
export function corpusContentDigest(members: readonly CorpusMemberIdentity[]): string {
  const hash = createHash('sha256');
  hash.update(`v${CORPUS_CONTRACT_VERSION}\n`);
  for (const member of members) {
    hash.update(`${member.id}\t${member.updatedAtEpoch}\t${member.shared ? 1 : 0}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Whether a stored artifact may be served for the current membership. The
 * comparison is the digest, never recency.
 */
export function isArtifactServable(
  artifactContentDigest: string,
  liveMembers: readonly CorpusMemberIdentity[],
): boolean {
  return artifactContentDigest === corpusContentDigest(liveMembers);
}

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
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  /**
   * Prior turns, oldest first. The server holds no conversation state (ADR D4),
   * so multi-turn context is the client's to carry and to trim. Bounded because
   * it is appended after the corpus prefix on a read-scoped key.
   */
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(MAX_HISTORY_CONTENT_CHARS),
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
 * How a read tool names its corpus: `name` within the caller's own project, or
 * `corpusId` for a corpus discovered through `list_corpora` with `scope: shared`,
 * whose name is not a cross-tenant identity. Exactly one, because accepting both
 * would leave precedence to guesswork.
 */
export const CorpusRefSchema = z.object({
  name: CorpusNameSchema.optional(),
  corpusId: z.string().min(1).optional(),
}).refine(
  (ref) => (ref.name == null) !== (ref.corpusId == null),
  { message: 'Provide exactly one of name or corpusId' },
);

/**
 * Stats are derived, never client-supplied. `observationCount` is the count of
 * members still resolvable at render time, so it can fall when an observation is
 * deleted or un-shared (ADR D2).
 */
export const CorpusStatsSchema = z.object({
  observationCount: z.number().int().nonnegative(),
  /**
   * Rows the filter matched before `limit` was applied, with `truncated` set when
   * it exceeded `limit`. Truncation is a legitimate client choice; going silent
   * about it is not (ADR D5).
   */
  matchedCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  tokenEstimate: z.number().int().nonnegative(),
  kindBreakdown: z.record(z.string(), z.number().int().nonnegative()),
  earliestAtEpoch: z.number().int().nonnegative().nullable(),
  latestAtEpoch: z.number().int().nonnegative().nullable(),
}).strict();

export const CorpusSummarySchema = z.object({
  id: z.string().min(1),
  /** Omitted when `foreign` is true: the owner's project id is provenance, not published content. */
  projectId: z.string().min(1).optional(),
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
 * Member rows, returned only for `?include=sources`. A shared corpus may only
 * contain already-shared observations (ADR D3), so the content is publishable --
 * but publishing shares content, not provenance. Outside the owning tenant these
 * rows carry the same redaction POST /v1/search { scope: 'shared' } applies
 * (MCAA-281): `projectId` and `metadata` are omitted.
 */
export const CorpusSourceSchema = z.object({
  id: z.string().min(1),
  /** Omitted on a foreign corpus: caller-supplied text, usually a repo or directory name. */
  projectId: z.string().min(1).optional(),
  kind: z.string().min(1),
  content: z.string(),
  /** Omitted on a foreign corpus: publisher-controlled JSON, stamped with the publishing agent's id. */
  metadata: z.record(z.string(), z.unknown()).optional(),
  shared: z.boolean(),
  /** Render index, derived from CORPUS_MEMBER_ORDER at read time, not stored. */
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
 * Which ceiling a CorpusTooLarge hit, so the client knows whether to narrow the
 * row count or the content volume -- the two need different fixes.
 */
export const CorpusTooLargeSchema = z.object({
  error: z.literal('CorpusTooLarge'),
  message: z.string().min(1),
  reason: z.enum(['members', 'tokens']),
  matchedCount: z.number().int().nonnegative(),
  tokenEstimate: z.number().int().nonnegative(),
  maxMembers: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
}).strict();

/** Carries the disqualifying count so the caller can see the size of the mistake. */
export const SharedCorpusPrivateMembersSchema = z.object({
  error: z.literal('SharedCorpusPrivateMembers'),
  message: z.string().min(1),
  privateMemberCount: z.number().int().positive(),
}).strict();

/**
 * Anything other than the literal 'shared' means the tenant-only scope. An
 * unrecognised or forged value can only ever narrow a read, never widen it --
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
 * Id-addressed read companion. A `name` is only unique per (team, project), so it
 * is not a cross-tenant identity: without these two routes a corpus discovered
 * via `?scope=shared` could be listed but never read or queried, and the list
 * scope would be dead weight (ADR D1).
 *
 * Read-only by construction. There is no id-addressed build, rebuild, prime,
 * reprime or delete: mutating another tenant's corpus is not a capability this
 * contract grants, and for your own corpus the project-scoped path already works.
 */
export const CORPUS_ID_PATHS = {
  item: '/v1/corpora/:corpusId',
  query: '/v1/corpora/:corpusId/query',
} as const;

/**
 * Who an id-addressed route will serve. Own-tenant rows always; another tenant's
 * row only when it is published. Anything else is 404, never 403, so a probe
 * cannot confirm that an id exists (ADR D6).
 */
export const CORPUS_ID_VISIBILITY = 'own-tenant-or-shared' as const;

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

const CORPUS_ID_PROPERTY = {
  type: 'string',
  description:
    'Corpus id, as returned by list_corpora. Use instead of name to read a corpus '
    + 'another tenant published as shared, whose name is not unique across tenants.',
} as const;

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
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_CORPUS_MEMBERS,
          description:
            'Maximum members to keep, newest first (default 500). The response reports '
            + 'matchedCount and truncated so you can tell whether anything was dropped.',
        },
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
    description:
      'Read one corpus: description, stats and filter. Pass includeSources to also return its '
      + 'member observations. Identify it by name (your own project) or by corpusId (a corpus '
      + 'another tenant shared) -- exactly one of the two.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROPERTY,
        name: NAME_PROPERTY,
        corpusId: CORPUS_ID_PROPERTY,
        includeSources: { type: 'boolean', description: 'Also return the member observations.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'prime_corpus',
    description:
      'Materialise a corpus into its rendered form so later questions are cheap. Optional -- '
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
      'Ask a question against a corpus. Each call is independent -- the server keeps no '
      + 'conversation state, so pass prior turns in history if you need follow-up context. '
      + 'Identify the corpus by name or by corpusId, exactly one of the two.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: PROJECT_ID_PROPERTY,
        name: NAME_PROPERTY,
        corpusId: CORPUS_ID_PROPERTY,
        question: { type: 'string', maxLength: MAX_QUESTION_CHARS, description: 'The question to ask.' },
        history: {
          type: 'array',
          maxItems: MAX_QUERY_HISTORY_TURNS,
          description: 'Prior turns, oldest first.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant'] },
              content: { type: 'string', maxLength: MAX_HISTORY_CONTENT_CHARS },
            },
            required: ['role', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['question'],
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
    description:
      'Discard a corpus\'s cached rendering and re-materialise it. Cache invalidation only -- '
      + 'there is no conversation state to clear, because the server keeps none.',
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
 * Frozen required-argument set. This copy is for consumers; the golden test
 * asserts against its own inlined literal rather than importing this one, so
 * editing both together cannot silently pass (ADR D8 rule 3).
 *
 * `get_corpus` and `query_corpus` require no name because either identifies its
 * corpus by `name` or `corpusId` (CorpusRefSchema). Relaxing a requirement keeps
 * every previously valid call valid; the freeze still catches the two breaking
 * directions, a rename and a newly-required argument.
 */
export const CORPUS_MCP_REQUIRED_ARGS: Record<CorpusToolName, readonly string[]> = {
  build_corpus: ['name'],
  list_corpora: [],
  get_corpus: [],
  prime_corpus: ['name'],
  query_corpus: ['question'],
  rebuild_corpus: ['name'],
  reprime_corpus: ['name'],
  delete_corpus: ['name'],
};

/**
 * The six corpus tool names that already exist on the local stdio server and must
 * not diverge remotely (ADR D7). `get_corpus` and `delete_corpus` are remote
 * additions with no local counterpart, so they are deliberately absent.
 *
 * Name parity is real; argument parity is not, and only for `build_corpus` --
 * local takes `types`/`concepts`/`files` as comma-separated strings with ISO
 * dates, remote takes `kinds`/`metadataMatch` with epoch integers. A skill
 * passing local `build_corpus` arguments fails loudly against remote.
 */
export const LOCAL_STDIO_CORPUS_TOOLS: readonly string[] = [
  'build_corpus',
  'list_corpora',
  'prime_corpus',
  'query_corpus',
  'rebuild_corpus',
  'reprime_corpus',
];

/** Tools that carry the scope opt-in, because for them it changes behaviour. */
export const CORPUS_MCP_SCOPED_TOOLS: readonly CorpusToolName[] = ['build_corpus', 'list_corpora'];
