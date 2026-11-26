// SPDX-License-Identifier: Apache-2.0
//
// Corpus tool dispatch for the remote MCP surface (MCAA-260, ADR 0001 D7).
//
// Tool names match the local stdio server exactly, so a skill that says "call
// prime_corpus" works in both modes. Arguments are flat on the wire (the local
// tools are flat too) and are folded into the contract's request shapes here,
// then validated by the contract schemas rather than by hand.

import {
  BuildCorpusRequestSchema,
  MAX_QUERY_HISTORY_TURNS,
  ProjectableCorpusFilterSchema,
  QueryCorpusRequestSchema,
  parseCorpusScope,
  type BuildCorpusRequest,
  type CorpusScope,
} from '../contracts/corpus-v1.js';

export interface CorpusToolCaller {
  projectId: string;
}

/**
 * The seam to storage, already bound to the authenticated key's team. Mirrors
 * `RecallBackend`: this module stays pure and testable without Postgres.
 */
export interface CorpusBackend {
  /**
   * Project used when a call omits `projectId` — the API key's project scope
   * on the server side. Null when the key is team-scoped, which makes
   * `projectId` effectively required and the error says so by name.
   */
  readonly defaultProjectId: string | null;
  build(caller: CorpusToolCaller, request: BuildCorpusRequest): Promise<unknown>;
  list(caller: CorpusToolCaller, input: { scope: CorpusScope; limit?: number }): Promise<unknown>;
  get(caller: CorpusToolCaller, ref: CorpusRef, options: { includeSources: boolean }): Promise<unknown>;
  prime(caller: CorpusToolCaller, name: string): Promise<unknown>;
  query(caller: CorpusToolCaller, ref: CorpusRef, input: {
    question: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<unknown>;
  rebuild(caller: CorpusToolCaller, name: string): Promise<unknown>;
  reprime(caller: CorpusToolCaller, name: string): Promise<unknown>;
  delete(caller: CorpusToolCaller, name: string): Promise<unknown>;
}

/** Exactly one of the two, because precedence should never be guesswork. */
export type CorpusRef = { name: string; corpusId?: undefined } | { corpusId: string; name?: undefined };

function resolveCaller(backend: CorpusBackend, args: Record<string, unknown>): CorpusToolCaller {
  const raw = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  const projectId = raw.length > 0 ? raw : backend.defaultProjectId;
  if (!projectId) {
    throw new Error(
      '"projectId" is required: this API key is not scoped to a project, so there is no default. '
      + 'Pass projectId, or set CLAUDE_MEM_PROJECT_ID in remote mode.',
    );
  }
  return { projectId };
}

function requireName(args: Record<string, unknown>): string {
  const value = args.name;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('"name" is required');
  }
  return value;
}

function resolveRef(args: Record<string, unknown>): CorpusRef {
  const name = typeof args.name === 'string' && args.name.trim().length > 0 ? args.name : null;
  const corpusId = typeof args.corpusId === 'string' && args.corpusId.trim().length > 0 ? args.corpusId : null;
  if ((name === null) === (corpusId === null)) {
    throw new Error('Provide exactly one of "name" or "corpusId"');
  }
  return name !== null ? { name } : { corpusId: corpusId! };
}

function parseHistory(raw: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(raw)) return [];
  const parsed = QueryCorpusRequestSchema.shape.history.safeParse(raw.slice(0, MAX_QUERY_HISTORY_TURNS));
  if (!parsed.success) {
    throw new Error('"history" must be turns of { role: "user" | "assistant", content: string }');
  }
  return [...(parsed.data ?? [])];
}

/**
 * Local filter arguments with no column behind them on the server. Accepting
 * and ignoring one would return a plausible, wrong corpus, so each is rejected
 * by name with its substitute (ADR 0001 D5).
 */
const UNSUPPORTED_FILTER_ARGS: Record<string, string> = {
  types: 'kinds',
  concepts: 'metadataMatch',
  files: 'metadataMatch',
  dateStart: 'dateStartEpoch',
  dateEnd: 'dateEndEpoch',
  project: 'projectId',
};

/** Fold the flat tool arguments into the contract's build request. */
export function buildRequestFromToolArgs(args: Record<string, unknown>): BuildCorpusRequest {
  for (const [unsupported, substitute] of Object.entries(UNSUPPORTED_FILTER_ARGS)) {
    if (args[unsupported] !== undefined) {
      throw new Error(
        `Invalid corpus filter: "${unsupported}" is not supported by the remote server; use "${substitute}" instead.`,
      );
    }
  }
  const filterInput: Record<string, unknown> = {};
  for (const key of ['kinds', 'query', 'platformSource', 'dateStartEpoch', 'dateEndEpoch', 'metadataMatch', 'limit']) {
    if (args[key] !== undefined) filterInput[key] = args[key];
  }
  // An unrecognised scope narrows to 'project' on the MCP path, matching
  // parseScope() in the recall server. It can never widen a read.
  filterInput.scope = parseCorpusScope(args.scope);
  const filter = ProjectableCorpusFilterSchema.safeParse(filterInput);
  if (!filter.success) {
    throw new Error(`Invalid corpus filter: ${filter.error.issues.map(issue => issue.message).join('; ')}`);
  }
  const request = BuildCorpusRequestSchema.safeParse({
    name: requireName(args),
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
    filter: filter.data,
    ...(args.shared !== undefined ? { shared: args.shared === true } : {}),
  });
  if (!request.success) {
    throw new Error(request.error.issues.map(issue => issue.message).join('; '));
  }
  return request.data;
}

/**
 * Dispatch one corpus tool call. Throws on unknown tools or invalid arguments;
 * the MCP server converts those into tool errors.
 */
export async function dispatchCorpusToolCall(
  backend: CorpusBackend,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const caller = resolveCaller(backend, args);
  switch (name) {
    case 'build_corpus':
      return backend.build(caller, buildRequestFromToolArgs(args));
    case 'list_corpora':
      return backend.list(caller, {
        scope: parseCorpusScope(args.scope),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      });
    case 'get_corpus':
      return backend.get(caller, resolveRef(args), { includeSources: args.includeSources === true });
    case 'prime_corpus':
      return backend.prime(caller, requireName(args));
    case 'query_corpus': {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (question.length === 0) throw new Error('"question" is required');
      return backend.query(caller, resolveRef(args), {
        question,
        history: parseHistory(args.history),
      });
    }
    case 'rebuild_corpus':
      return backend.rebuild(caller, requireName(args));
    case 'reprime_corpus':
      return backend.reprime(caller, requireName(args));
    case 'delete_corpus':
      return backend.delete(caller, requireName(args));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
