// SPDX-License-Identifier: Apache-2.0
//
// Remote client mode: point the plugin, hooks and MCP search server at a
// centrally hosted claude-mem server instead of a local worker + SQLite.
//
// Remote mode differs from the existing `CLAUDE_MEM_RUNTIME=server` runtime in
// one decisive way: it never falls back. `runtime=server` degrades to the
// worker when its configuration is incomplete, which on a Kubernetes pod or a
// Paperclip agent silently writes memory to a local SQLite file nobody reads.
// In remote mode an incomplete configuration is a hard error, no worker is
// spawned, and no local database is opened.
//
// Configuration comes from the process environment first so a container can be
// configured entirely through env vars (the Helm chart's contract), then from
// `~/.claude-mem/settings.json` for interactive installs.

export const REMOTE_MODE_ENV_KEYS = {
  runtime: 'CLAUDE_MEM_RUNTIME',
  serverUrl: 'CLAUDE_MEM_SERVER_URL',
  apiKey: 'CLAUDE_MEM_API_KEY',
  apiKeyLegacy: 'CLAUDE_MEM_SERVER_API_KEY',
  projectId: 'CLAUDE_MEM_PROJECT_ID',
  projectIdLegacy: 'CLAUDE_MEM_SERVER_PROJECT_ID',
  agentId: 'CLAUDE_MEM_AGENT_ID',
  includeShared: 'CLAUDE_MEM_INCLUDE_SHARED',
} as const;

export const REMOTE_RUNTIME_VALUE = 'remote';

export interface RemoteModeConfig {
  serverUrl: string;
  apiKey: string;
  projectId: string;
  /** Optional agent identity recorded on every write alongside team + project. */
  agentId: string | null;
  /** When true, reads default to the shared scope instead of this tenant only. */
  includeShared: boolean;
}

export type RemoteModeConfigErrorReason =
  | 'missing_server_url'
  | 'missing_api_key'
  | 'missing_project_id'
  | 'invalid_server_url';

export class RemoteModeConfigError extends Error {
  readonly reason: RemoteModeConfigErrorReason;

  constructor(reason: RemoteModeConfigErrorReason, message: string) {
    super(message);
    this.name = 'RemoteModeConfigError';
    this.reason = reason;
  }
}

/** Thrown when remote mode is active and something asks for local storage. */
export class RemoteModeLocalStorageError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(
      `${operation} is unavailable in remote mode: claude-mem is configured against ${REMOTE_MODE_ENV_KEYS.serverUrl}, `
      + 'so no local worker is spawned and no local database is opened. '
      + 'Unset CLAUDE_MEM_SERVER_URL (and CLAUDE_MEM_RUNTIME) to return to local worker mode.',
    );
    this.name = 'RemoteModeLocalStorageError';
    this.operation = operation;
  }
}

/** Settings-file shape this module reads; a subset of SettingsDefaults. */
export interface RemoteModeSettingsSource {
  CLAUDE_MEM_RUNTIME?: string;
  CLAUDE_MEM_SERVER_URL?: string;
  CLAUDE_MEM_API_KEY?: string;
  CLAUDE_MEM_SERVER_API_KEY?: string;
  CLAUDE_MEM_PROJECT_ID?: string;
  CLAUDE_MEM_SERVER_PROJECT_ID?: string;
  CLAUDE_MEM_AGENT_ID?: string;
  CLAUDE_MEM_INCLUDE_SHARED?: string;
}

export interface RemoteModeSources {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  settings?: RemoteModeSettingsSource;
}

function firstNonEmpty(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = (candidate ?? '').trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function isTruthyFlag(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * Remote mode is requested when a server URL is configured, or when the
 * runtime is explicitly set to `remote`. Presence of the URL is enough: a
 * container that has been handed a server address must never quietly write to
 * a local database instead.
 */
export function isRemoteModeRequested(sources: RemoteModeSources = {}): boolean {
  const env = sources.env ?? process.env;
  const settings = sources.settings ?? {};
  const runtime = firstNonEmpty(
    env[REMOTE_MODE_ENV_KEYS.runtime],
    settings.CLAUDE_MEM_RUNTIME,
  ).toLowerCase();
  if (runtime === REMOTE_RUNTIME_VALUE) return true;
  return firstNonEmpty(
    env[REMOTE_MODE_ENV_KEYS.serverUrl],
    settings.CLAUDE_MEM_SERVER_URL,
  ).length > 0;
}

/**
 * Resolve the full remote configuration. Throws `RemoteModeConfigError` when
 * remote mode is requested but under-configured — callers must surface that
 * error rather than degrading to the local worker.
 */
export function resolveRemoteModeConfig(sources: RemoteModeSources = {}): RemoteModeConfig {
  const env = sources.env ?? process.env;
  const settings = sources.settings ?? {};

  const serverUrl = firstNonEmpty(
    env[REMOTE_MODE_ENV_KEYS.serverUrl],
    settings.CLAUDE_MEM_SERVER_URL,
  );
  if (!serverUrl) {
    throw new RemoteModeConfigError(
      'missing_server_url',
      `Remote mode requires ${REMOTE_MODE_ENV_KEYS.serverUrl} (e.g. https://claude-mem.example.com).`,
    );
  }
  const normalizedUrl = normalizeServerUrl(serverUrl);

  const apiKey = firstNonEmpty(
    env[REMOTE_MODE_ENV_KEYS.apiKey],
    env[REMOTE_MODE_ENV_KEYS.apiKeyLegacy],
    settings.CLAUDE_MEM_API_KEY,
    settings.CLAUDE_MEM_SERVER_API_KEY,
  );
  if (!apiKey) {
    throw new RemoteModeConfigError(
      'missing_api_key',
      `Remote mode requires ${REMOTE_MODE_ENV_KEYS.apiKey}. The API key is the tenant binding: `
      + 'the server derives the team from it and refuses to read another tenant\'s rows.',
    );
  }

  const projectId = firstNonEmpty(
    env[REMOTE_MODE_ENV_KEYS.projectId],
    env[REMOTE_MODE_ENV_KEYS.projectIdLegacy],
    settings.CLAUDE_MEM_PROJECT_ID,
    settings.CLAUDE_MEM_SERVER_PROJECT_ID,
  );
  if (!projectId) {
    throw new RemoteModeConfigError(
      'missing_project_id',
      `Remote mode requires ${REMOTE_MODE_ENV_KEYS.projectId} — the project scope every write is recorded under.`,
    );
  }

  const agentId = firstNonEmpty(
    env[REMOTE_MODE_ENV_KEYS.agentId],
    settings.CLAUDE_MEM_AGENT_ID,
  );
  const includeShared = isTruthyFlag(firstNonEmpty(
    env[REMOTE_MODE_ENV_KEYS.includeShared],
    settings.CLAUDE_MEM_INCLUDE_SHARED,
  ));

  return {
    serverUrl: normalizedUrl,
    apiKey,
    projectId,
    agentId: agentId.length > 0 ? agentId : null,
    includeShared,
  };
}

function normalizeServerUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RemoteModeConfigError(
      'invalid_server_url',
      `${REMOTE_MODE_ENV_KEYS.serverUrl} is not a valid URL: ${raw}`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RemoteModeConfigError(
      'invalid_server_url',
      `${REMOTE_MODE_ENV_KEYS.serverUrl} must be http(s), got ${parsed.protocol}`,
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * Guard for every local-storage entry point (worker spawn, SQLite open).
 * A no-op outside remote mode so local installs are untouched.
 */
export function assertLocalStorageAllowed(
  operation: string,
  sources: RemoteModeSources = {},
): void {
  if (!isRemoteModeRequested(sources)) return;
  throw new RemoteModeLocalStorageError(operation);
}

/** Filename of the local memory database, matched to keep the guard narrow. */
const LOCAL_MEMORY_DB_FILENAME = 'claude-mem.db';

/**
 * Refuse to CREATE the local memory database while remote mode is active.
 *
 * Deliberately narrow on two axes. It matches the memory database only, so the
 * server process's own SQLite state (api keys, sessions) is untouched even when
 * the server pod also carries these env vars. And it only fires for an open
 * that could create the file — a read-only open of an existing database from a
 * previous local install stays allowed, so switching to remote mode does not
 * break tooling that inspects old data.
 */
export function assertLocalMemoryDatabaseAllowed(
  dbPath: string,
  options: { create: boolean },
  sources: RemoteModeSources = {},
): void {
  if (!options.create) return;
  const normalized = dbPath.replace(/\\/g, '/');
  if (!normalized.endsWith(`/${LOCAL_MEMORY_DB_FILENAME}`) && normalized !== LOCAL_MEMORY_DB_FILENAME) {
    return;
  }
  assertLocalStorageAllowed(`Creating the local memory database at ${dbPath}`, sources);
}

export function isRemoteModeConfigError(error: unknown): error is RemoteModeConfigError {
  return error instanceof RemoteModeConfigError;
}

export function isRemoteModeLocalStorageError(error: unknown): error is RemoteModeLocalStorageError {
  return error instanceof RemoteModeLocalStorageError;
}
