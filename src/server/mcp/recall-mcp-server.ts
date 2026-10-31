// SPDX-License-Identifier: Apache-2.0
//
// Remote-recall MCP server factory.
//
// Builds a low-level MCP `Server` exposing the read tools (`search`, `context`,
// `recent`) over an injected `RecallBackend`. The backend is the only seam to
// storage, so this factory is pure and unit-testable without Postgres — the
// route layer (ServerV1PostgresRoutes) supplies a backend already scoped to the
// authenticated API key's team (and honoring any project scope).
//
// This is the same recall surface the stdio MCP server exposes via
// ServerBetaClient (`/v1/search`, `/v1/context`), so a hosted MCP link and the
// local CLI read identical data. The mutating tools are intentionally absent:
// a pasted recall link is read-only.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger.js';
import { CORPUS_MCP_TOOLS } from '../contracts/corpus-v1.js';
import { dispatchCorpusToolCall, type CorpusBackend } from './corpus-mcp-tools.js';

export interface RecallBackend {
  // Returns serialized observations (already shaped by serializeObservation),
  // scoped to the caller's team. Throws if `projectId` is outside the key's scope.
  // `search` and `context` query identically; they are separate methods so the
  // route can audit each tool under its own mode (search vs context).
  search(args: { projectId: string; query: string; limit: number; scope: RecallScope }): Promise<unknown[]>;
  context(args: { projectId: string; query: string; limit: number; scope: RecallScope }): Promise<unknown[]>;
  recent(args: { projectId: string; limit: number; scope: RecallScope }): Promise<unknown[]>;
}

/**
 * `project` reads the caller's tenant only. `shared` additionally reads
 * observations other tenants explicitly published as shared. Opt-in per call,
 * so cross-tenant knowledge is reachable but never returned by accident.
 */
export type RecallScope = 'project' | 'shared';

const SCOPE_PROPERTY = {
  type: 'string',
  enum: ['project', 'shared'],
  description:
    "Read scope. 'project' (default) returns only your own tenant's memory. "
    + "'shared' also returns observations other tenants published as shared knowledge.",
} as const;

const SEARCH_LIMIT = { default: 20, max: 100 };
const CONTEXT_LIMIT = { default: 10, max: 50 };
const RECENT_LIMIT = { default: 20, max: 100 };

const TOOLS: Tool[] = [
  {
    name: 'search',
    description:
      'Full-text search your claude-mem memory for a project. Returns matching observations (most relevant first).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to search within.' },
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT.max },
        scope: SCOPE_PROPERTY,
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'context',
    description:
      'Like search, but also returns a concatenated context string ready to inject into a prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to search within.' },
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'integer', minimum: 1, maximum: CONTEXT_LIMIT.max },
        scope: SCOPE_PROPERTY,
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'recent',
    description: 'List the most recent observations for a project (newest first).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to list.' },
        limit: { type: 'integer', minimum: 1, maximum: RECENT_LIMIT.max },
        scope: SCOPE_PROPERTY,
      },
      required: ['projectId'],
    },
  },
];

function clampLimit(raw: unknown, spec: { default: number; max: number }): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return spec.default;
  return Math.min(Math.max(1, Math.trunc(raw)), spec.max);
}

// Anything other than the literal string 'shared' means the tenant-only scope.
// An unrecognised or forged value can only ever narrow the read, never widen it.
function parseScope(raw: unknown): RecallScope {
  return raw === 'shared' ? 'shared' : 'project';
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${key}" is required`);
  }
  return value;
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

// Dispatches a single tool call to the backend. Throws on unknown tools or
// invalid arguments; `createRecallMcpServer` converts those into MCP errors.
async function dispatchToolCall(
  backend: RecallBackend,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (name === 'search') {
    const observations = await backend.search({
      projectId: requireString(args, 'projectId'),
      query: requireString(args, 'query'),
      limit: clampLimit(args.limit, SEARCH_LIMIT),
      scope: parseScope(args.scope),
    });
    return jsonResult({ observations });
  }
  if (name === 'context') {
    const observations = await backend.context({
      projectId: requireString(args, 'projectId'),
      query: requireString(args, 'query'),
      limit: clampLimit(args.limit, CONTEXT_LIMIT),
      scope: parseScope(args.scope),
    });
    const context = observations
      .map((o) => (o as { content?: unknown }).content)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .join('\n\n');
    return jsonResult({ observations, context });
  }
  if (name === 'recent') {
    const observations = await backend.recent({
      projectId: requireString(args, 'projectId'),
      limit: clampLimit(args.limit, RECENT_LIMIT),
      scope: parseScope(args.scope),
    });
    return jsonResult({ observations });
  }
  throw new Error(`Unknown tool: ${name}`);
}

const CORPUS_TOOL_NAMES: ReadonlySet<string> = new Set(CORPUS_MCP_TOOLS.map(tool => tool.name));

// The contract declares the tools `as const` so the golden test can freeze
// their names and required arguments; widen them into the SDK's mutable Tool
// shape here rather than asserting the type away.
const CORPUS_TOOLS: Tool[] = CORPUS_MCP_TOOLS.map(tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    properties: { ...tool.inputSchema.properties },
    required: [...tool.inputSchema.required],
    additionalProperties: tool.inputSchema.additionalProperties,
  },
}));

/**
 * Build the recall MCP server bound to `backend`. The caller owns the transport
 * (stdio in the CLI, streamable-HTTP in Server Beta).
 *
 * `corpus` is optional: when supplied the server also advertises the corpus
 * tools (MCAA-260). Unlike the recall tools these include writes, so a
 * deployment that wants the pasted link to stay read-only simply omits it.
 */
export function createRecallMcpServer(
  backend: RecallBackend,
  version: string,
  corpus?: CorpusBackend | null,
): Server {
  const server = new Server(
    { name: 'claude-mem', version },
    { capabilities: { tools: {} } },
  );

  const tools: Tool[] = corpus ? [...TOOLS, ...CORPUS_TOOLS] : TOOLS;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (CORPUS_TOOL_NAMES.has(name)) {
        if (!corpus) throw new Error(`Unknown tool: ${name}`);
        return jsonResult(await dispatchCorpusToolCall(corpus, name, args));
      }
      return await dispatchToolCall(backend, name, args);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', 'recall MCP tool call failed', { tool: name }, err);
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });

  return server;
}

export const RECALL_MCP_TOOLS = TOOLS;
