// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'crypto';
import type pg from 'pg';
import {
  SERVER_POSTGRES_SCHEMA_VERSION,
  SERVER_SCHEMA_BOOTSTRAP_LOCK_KEY,
  bootstrapServerPostgresSchema,
} from '../../../src/storage/postgres/index.js';
import {
  readPostgresSchemaStatus,
  requireMigratedPostgresSchema,
  schemaBootstrapEnabled,
} from '../../../src/server/runtime/create-server-service.js';
import {
  IMPORTED_API_KEY_SCOPES,
  importServerApiKey,
  normalizeImportedApiKey,
} from '../../../src/server/runtime/api-key-import.js';
import { logger } from '../../../src/utils/logger.js';
import { createIsolatedSchema, dropSchema, poolForSchema } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('schema bootstrap serialization', () => {
  it('takes the transaction-scoped advisory lock before any DDL', async () => {
    const calls: { text: string; values?: unknown[] }[] = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return { rows: [], rowCount: 0 };
      },
    };

    await bootstrapServerPostgresSchema(client);

    expect(calls[0].text).toBe('BEGIN');
    expect(calls[1].text).toContain('pg_advisory_xact_lock');
    expect(calls[1].values).toEqual([SERVER_SCHEMA_BOOTSTRAP_LOCK_KEY]);
  });
});

describe('CLAUDE_MEM_SERVER_SCHEMA_BOOTSTRAP', () => {
  it('bootstraps by default so compose and local installs keep working', () => {
    expect(schemaBootstrapEnabled({})).toBe(true);
    expect(schemaBootstrapEnabled({ CLAUDE_MEM_SERVER_SCHEMA_BOOTSTRAP: 'true' })).toBe(true);
  });

  it('turns bootstrap off for false or 0', () => {
    expect(schemaBootstrapEnabled({ CLAUDE_MEM_SERVER_SCHEMA_BOOTSTRAP: 'false' })).toBe(false);
    expect(schemaBootstrapEnabled({ CLAUDE_MEM_SERVER_SCHEMA_BOOTSTRAP: ' FALSE ' })).toBe(false);
    expect(schemaBootstrapEnabled({ CLAUDE_MEM_SERVER_SCHEMA_BOOTSTRAP: '0' })).toBe(false);
  });

  it('refuses to boot without bootstrap when the version row is missing', async () => {
    const pool = { async query() { return { rows: [], rowCount: 0 }; } };
    await expect(requireMigratedPostgresSchema(pool)).rejects.toThrow(/Run `server migrate`/);
  });

  it('names server migrate when the migrations table does not exist yet', async () => {
    const pool = {
      async query(): Promise<never> {
        throw new Error('relation "server_beta_schema_migrations" does not exist');
      },
    };
    await expect(requireMigratedPostgresSchema(pool)).rejects.toThrow(/does not exist.*Run `server migrate`/);
  });

  it('reports the applied version without running DDL', async () => {
    const texts: string[] = [];
    const pool = {
      async query(text: string) {
        texts.push(text);
        return { rows: [{ version: SERVER_POSTGRES_SCHEMA_VERSION, applied_at: new Date(0) }], rowCount: 1 };
      },
    };
    const status = await requireMigratedPostgresSchema(pool);
    expect(status).toEqual({
      initialized: true,
      schemaVersion: SERVER_POSTGRES_SCHEMA_VERSION,
      appliedAt: new Date(0).toISOString(),
    });
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toMatch(/CREATE|ALTER|INSERT/);
  });
});

describe('imported API key validation', () => {
  it('trims a trailing newline from a Secret-mounted key', () => {
    const key = 'k'.repeat(40);
    expect(normalizeImportedApiKey(`${key}\n`, 'agent-a')).toBe(key);
  });

  it('rejects a short key and names the entry', () => {
    expect(() => normalizeImportedApiKey('short', 'agent-a')).toThrow(/"agent-a" is 5 characters/);
  });

  it('rejects a file holding more than one key', () => {
    expect(() => normalizeImportedApiKey(`${'a'.repeat(40)}\n${'b'.repeat(40)}`, 'agent-a')).toThrow(/whitespace/);
  });

  it('never grants a shared-publish or wildcard scope', () => {
    expect([...IMPORTED_API_KEY_SCOPES]).toEqual(['memories:read', 'memories:write']);
  });
});

describe('server migrate and api-key import against Postgres', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let schemaName: string;
  let pools: pg.Pool[];
  let spies: ReturnType<typeof spyOn>[];

  beforeEach(async () => {
    spies = (['info', 'warn', 'error', 'debug'] as const).map(m => spyOn(logger, m).mockImplementation(() => {}));
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_migrate');
    pools = [];
  });

  afterEach(async () => {
    await Promise.all(pools.map(pool => pool.end()));
    await dropSchema(testDatabaseUrl, schemaName);
    spies.forEach(spy => spy.mockRestore());
  });

  const newPool = () => {
    const pool = poolForSchema(testDatabaseUrl, schemaName);
    pools.push(pool);
    return pool;
  };

  it('applies the schema once when several processes bootstrap concurrently', async () => {
    await Promise.all(Array.from({ length: 4 }, () => bootstrapServerPostgresSchema(newPool())));

    const pool = newPool();
    const status = await readPostgresSchemaStatus(pool);
    expect(status.initialized).toBe(true);
    const rows = await pool.query('SELECT version FROM server_beta_schema_migrations');
    expect(rows.rowCount).toBe(1);
  });

  it('imports a key once, with read/write scopes only, and reports it on rerun', async () => {
    const pool = newPool();
    await bootstrapServerPostgresSchema(pool);
    const rawKey = 'cmem_' + 'a1'.repeat(24);

    const first = await importServerApiKey(pool, { name: 'agent-a', rawKey: `${rawKey}\n` });
    const second = await importServerApiKey(pool, { name: 'agent-a', rawKey });

    expect(first.status).toBe('imported');
    expect(second).toEqual({ ...first, status: 'exists' });
    const stored = await pool.query<{ scopes: string[]; key_hash: string }>('SELECT scopes, key_hash FROM api_keys');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].scopes).toEqual(['memories:read', 'memories:write']);
    expect(stored.rows[0].key_hash).toBe(createHash('sha256').update(rawKey).digest('hex'));
  });

  it('reports a revoked key instead of reviving it', async () => {
    const pool = newPool();
    await bootstrapServerPostgresSchema(pool);
    const rawKey = 'cmem_' + 'b2'.repeat(24);
    const first = await importServerApiKey(pool, { name: 'agent-b', rawKey });
    await pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [first.id]);

    const rerun = await importServerApiKey(pool, { name: 'agent-b', rawKey });

    expect(rerun.status).toBe('revoked');
    const stored = await pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM api_keys WHERE id = $1', [first.id]);
    expect(stored.rows[0].revoked_at).not.toBeNull();
  });
});
