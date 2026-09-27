// SPDX-License-Identifier: Apache-2.0
//
// MCAA-237 — remote client mode.
//
// The contract these tests pin down:
//   1. A server URL in the environment puts the client in remote mode.
//   2. An incomplete remote configuration is a HARD ERROR, never a silent
//      downgrade to the local worker.
//   3. Remote mode refuses to create the local memory database.
// (2) is the reason this mode exists: falling back would write memory to a
// SQLite file on a pod nobody reads from.

import { describe, expect, it } from 'bun:test';
import {
  REMOTE_MODE_ENV_KEYS,
  RemoteModeConfigError,
  RemoteModeLocalStorageError,
  assertLocalMemoryDatabaseAllowed,
  assertLocalStorageAllowed,
  isRemoteModeRequested,
  resolveRemoteModeConfig,
} from '../../src/shared/remote-mode.js';

const REMOTE_ENV = {
  CLAUDE_MEM_SERVER_URL: 'https://claude-mem.example.com',
  CLAUDE_MEM_API_KEY: 'cm_test_key',
  CLAUDE_MEM_PROJECT_ID: 'homelab',
};

describe('isRemoteModeRequested', () => {
  it('is false with no server url and no runtime override', () => {
    expect(isRemoteModeRequested({ env: {}, settings: {} })).toBe(false);
  });

  it('is true when the server url is in the environment', () => {
    expect(isRemoteModeRequested({ env: { CLAUDE_MEM_SERVER_URL: 'https://x.test' }, settings: {} })).toBe(true);
  });

  it('is true when the server url comes from settings.json', () => {
    expect(isRemoteModeRequested({ env: {}, settings: { CLAUDE_MEM_SERVER_URL: 'https://x.test' } })).toBe(true);
  });

  it('is true for CLAUDE_MEM_RUNTIME=remote even before the url is set', () => {
    // So a misconfigured pod fails loudly instead of quietly running local.
    expect(isRemoteModeRequested({ env: { CLAUDE_MEM_RUNTIME: 'remote' }, settings: {} })).toBe(true);
  });

  it('ignores an empty-string server url, which settings.json writes for unset keys', () => {
    expect(isRemoteModeRequested({ env: { CLAUDE_MEM_SERVER_URL: '   ' }, settings: {} })).toBe(false);
  });

  it('does not treat the legacy server runtime as remote mode', () => {
    expect(isRemoteModeRequested({ env: {}, settings: { CLAUDE_MEM_RUNTIME: 'server' } })).toBe(false);
  });
});

describe('resolveRemoteModeConfig', () => {
  it('resolves a complete environment', () => {
    const config = resolveRemoteModeConfig({ env: REMOTE_ENV, settings: {} });
    expect(config).toEqual({
      serverUrl: 'https://claude-mem.example.com',
      apiKey: 'cm_test_key',
      projectId: 'homelab',
      agentId: null,
      includeShared: false,
    });
  });

  it('prefers the environment over settings.json', () => {
    const config = resolveRemoteModeConfig({
      env: REMOTE_ENV,
      settings: {
        CLAUDE_MEM_SERVER_URL: 'https://stale.example.com',
        CLAUDE_MEM_API_KEY: 'cm_stale',
        CLAUDE_MEM_PROJECT_ID: 'stale-project',
      },
    });
    expect(config.serverUrl).toBe('https://claude-mem.example.com');
    expect(config.apiKey).toBe('cm_test_key');
    expect(config.projectId).toBe('homelab');
  });

  it('accepts the legacy CLAUDE_MEM_SERVER_{API_KEY,PROJECT_ID} names', () => {
    const config = resolveRemoteModeConfig({
      env: {
        CLAUDE_MEM_SERVER_URL: 'https://claude-mem.example.com',
        CLAUDE_MEM_SERVER_API_KEY: 'cm_legacy',
        CLAUDE_MEM_SERVER_PROJECT_ID: 'legacy-project',
      },
      settings: {},
    });
    expect(config.apiKey).toBe('cm_legacy');
    expect(config.projectId).toBe('legacy-project');
  });

  it('carries the agent identity when one is configured', () => {
    const config = resolveRemoteModeConfig({
      env: { ...REMOTE_ENV, CLAUDE_MEM_AGENT_ID: 'senior-app-engineer' },
      settings: {},
    });
    expect(config.agentId).toBe('senior-app-engineer');
  });

  it('opts into the shared read scope only for truthy flag values', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(resolveRemoteModeConfig({ env: { ...REMOTE_ENV, CLAUDE_MEM_INCLUDE_SHARED: value }, settings: {} }).includeShared).toBe(true);
    }
    for (const value of ['0', 'false', 'no', '', 'maybe']) {
      expect(resolveRemoteModeConfig({ env: { ...REMOTE_ENV, CLAUDE_MEM_INCLUDE_SHARED: value }, settings: {} }).includeShared).toBe(false);
    }
  });

  it('strips a trailing slash so path joining cannot double up', () => {
    const config = resolveRemoteModeConfig({
      env: { ...REMOTE_ENV, CLAUDE_MEM_SERVER_URL: 'https://claude-mem.example.com/' },
      settings: {},
    });
    expect(config.serverUrl).toBe('https://claude-mem.example.com');
  });

  it('throws rather than falling back when the api key is missing', () => {
    expect(() => resolveRemoteModeConfig({
      env: { CLAUDE_MEM_SERVER_URL: REMOTE_ENV.CLAUDE_MEM_SERVER_URL, CLAUDE_MEM_PROJECT_ID: 'homelab' },
      settings: {},
    })).toThrow(RemoteModeConfigError);
  });

  it('names the missing key so the failure is actionable', () => {
    try {
      resolveRemoteModeConfig({
        env: { CLAUDE_MEM_SERVER_URL: REMOTE_ENV.CLAUDE_MEM_SERVER_URL, CLAUDE_MEM_API_KEY: 'cm_x' },
        settings: {},
      });
      throw new Error('expected a RemoteModeConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteModeConfigError);
      const configError = error as RemoteModeConfigError;
      expect(configError.reason).toBe('missing_project_id');
      expect(configError.message).toContain(REMOTE_MODE_ENV_KEYS.projectId);
    }
  });

  it('throws when the runtime says remote but no url was given', () => {
    try {
      resolveRemoteModeConfig({ env: { CLAUDE_MEM_RUNTIME: 'remote' }, settings: {} });
      throw new Error('expected a RemoteModeConfigError');
    } catch (error) {
      expect((error as RemoteModeConfigError).reason).toBe('missing_server_url');
    }
  });

  it('rejects a non-http url scheme', () => {
    try {
      resolveRemoteModeConfig({ env: { ...REMOTE_ENV, CLAUDE_MEM_SERVER_URL: 'file:///etc/passwd' }, settings: {} });
      throw new Error('expected a RemoteModeConfigError');
    } catch (error) {
      expect((error as RemoteModeConfigError).reason).toBe('invalid_server_url');
    }
  });

  it('rejects an unparseable url', () => {
    try {
      resolveRemoteModeConfig({ env: { ...REMOTE_ENV, CLAUDE_MEM_SERVER_URL: 'not a url' }, settings: {} });
      throw new Error('expected a RemoteModeConfigError');
    } catch (error) {
      expect((error as RemoteModeConfigError).reason).toBe('invalid_server_url');
    }
  });
});

describe('local-storage guards', () => {
  it('allows local storage outside remote mode', () => {
    expect(() => assertLocalStorageAllowed('spawning the worker', { env: {}, settings: {} })).not.toThrow();
  });

  it('blocks local storage in remote mode', () => {
    expect(() => assertLocalStorageAllowed('spawning the worker', { env: REMOTE_ENV, settings: {} }))
      .toThrow(RemoteModeLocalStorageError);
  });

  it('blocks creating the memory database in remote mode', () => {
    expect(() => assertLocalMemoryDatabaseAllowed(
      '/home/agent/.claude-mem/claude-mem.db',
      { create: true },
      { env: REMOTE_ENV, settings: {} },
    )).toThrow(RemoteModeLocalStorageError);
  });

  it('still allows a read-only open of an existing memory database', () => {
    // Switching to remote mode must not break tooling that inspects old data.
    expect(() => assertLocalMemoryDatabaseAllowed(
      '/home/agent/.claude-mem/claude-mem.db',
      { create: false },
      { env: REMOTE_ENV, settings: {} },
    )).not.toThrow();
  });

  it('leaves other sqlite databases alone, including the server\'s own state', () => {
    // The server pod may carry these env vars for self-reference; its api-key
    // database must keep working.
    expect(() => assertLocalMemoryDatabaseAllowed(
      '/var/lib/claude-mem/server-auth.db',
      { create: true },
      { env: REMOTE_ENV, settings: {} },
    )).not.toThrow();
  });

  it('matches the memory database on a windows-style path too', () => {
    expect(() => assertLocalMemoryDatabaseAllowed(
      'C:\\Users\\agent\\.claude-mem\\claude-mem.db',
      { create: true },
      { env: REMOTE_ENV, settings: {} },
    )).toThrow(RemoteModeLocalStorageError);
  });
});
