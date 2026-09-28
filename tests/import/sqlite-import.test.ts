// SPDX-License-Identifier: Apache-2.0
//
// MCAA-241 — the import contract, exercised against a real SQLite database
// built with the local schema's own column set.
//
// What must hold:
// - a second run over the same source adds nothing (idempotent by construction)
// - every write carries the tenant scope (projectId) and the agent identity
// - a run with no project id is refused rather than writing unscoped rows

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildImportIdempotencyKey,
  importSqliteDatabase,
  renderObservationContent,
  SqliteImportSourceError,
  type ImportWriteClient,
  type ImportWriteRequest,
} from '../../src/services/import/sqlite-import.js';

/**
 * Stands in for the central server's observations table: keyed by the same
 * (project, idempotency key) pair the unique index enforces in Postgres, so a
 * duplicate insert is reported as already present instead of adding a row.
 */
class FakeCentralServer implements ImportWriteClient {
  readonly rows = new Map<string, ImportWriteRequest>();
  readonly requests: ImportWriteRequest[] = [];

  async addObservation(request: ImportWriteRequest): Promise<{ created: boolean }> {
    this.requests.push(request);
    const key = `${request.projectId}::${request.idempotencyKey}`;
    if (this.rows.has(key)) return { created: false };
    this.rows.set(key, request);
    return { created: true };
  }
}

describe('MCAA-241 — SQLite to central server import', () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmem-import-'));
    databasePath = join(dir, 'claude-mem.db');
    seedLocalDatabase(databasePath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports every row once and adds nothing on the second run', async () => {
    const server = new FakeCentralServer();

    const first = await importSqliteDatabase(
      { databasePath, projectId: 'proj-homelab', agentId: 'agent-7' },
      server,
    );
    expect(first.totals.scanned).toBe(4);
    expect(first.totals.created).toBe(3);
    expect(first.totals.skippedEmpty).toBe(1);
    expect(first.totals.alreadyPresent).toBe(0);
    expect(first.totals.failed).toBe(0);
    const rowsAfterFirst = server.rows.size;
    expect(rowsAfterFirst).toBe(3);

    const second = await importSqliteDatabase(
      { databasePath, projectId: 'proj-homelab', agentId: 'agent-7' },
      server,
    );
    expect(second.totals.scanned).toBe(4);
    expect(second.totals.created).toBe(0);
    expect(second.totals.alreadyPresent).toBe(3);
    expect(second.totals.failed).toBe(0);
    expect(server.rows.size).toBe(rowsAfterFirst);
  });

  it('scopes every write to the project and records the agent identity', async () => {
    const server = new FakeCentralServer();
    await importSqliteDatabase(
      { databasePath, projectId: 'proj-homelab', agentId: 'agent-7' },
      server,
    );

    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests) {
      expect(request.projectId).toBe('proj-homelab');
      expect(request.agentId).toBe('agent-7');
      expect(request.idempotencyKey.startsWith('import:sqlite-v1:')).toBe(true);
      expect(request.metadata.source).toBe('sqlite-import');
      expect(request.metadata.sourceSessionId).toBe('sess-1');
    }
  });

  it('refuses to run without a project id', async () => {
    const server = new FakeCentralServer();
    await expect(
      importSqliteDatabase({ databasePath, projectId: '   ' }, server),
    ).rejects.toBeInstanceOf(SqliteImportSourceError);
    expect(server.requests).toEqual([]);
  });

  it('rejects a database that is not a claude-mem store', async () => {
    const strangerPath = join(dir, 'stranger.db');
    const stranger = new Database(strangerPath);
    stranger.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    stranger.close();

    await expect(
      importSqliteDatabase({ databasePath: strangerPath, projectId: 'proj-homelab' }, new FakeCentralServer()),
    ).rejects.toBeInstanceOf(SqliteImportSourceError);
  });

  it('sends nothing in dry-run mode but still reports what it would send', async () => {
    const server = new FakeCentralServer();
    const result = await importSqliteDatabase(
      { databasePath, projectId: 'proj-homelab', dryRun: true },
      server,
    );
    expect(result.dryRun).toBe(true);
    expect(result.totals.created).toBe(3);
    expect(server.requests).toEqual([]);
  });

  it('filters to the requested local project', async () => {
    const server = new FakeCentralServer();
    const result = await importSqliteDatabase(
      { databasePath, projectId: 'proj-homelab', sourceProjects: ['other-repo'] },
      server,
    );
    expect(result.totals.scanned).toBe(1);
    expect(server.requests.length).toBe(1);
    expect(server.requests[0]?.metadata.sourceProject).toBe('other-repo');
  });

  it('keeps counting a failed row instead of aborting the run', async () => {
    const failing: ImportWriteClient = {
      async addObservation() {
        throw new Error('server returned 503');
      },
    };
    const result = await importSqliteDatabase(
      { databasePath, projectId: 'proj-homelab' },
      failing,
    );
    expect(result.totals.created).toBe(0);
    expect(result.totals.failed).toBe(3);
    expect(result.failures[0]?.error).toContain('503');
  });

  it('derives the same key for the same row and a different key per row', () => {
    const first = buildImportIdempotencyKey({ table: 'observations', sessionId: 'sess-1', rowId: 1 });
    const again = buildImportIdempotencyKey({ table: 'observations', sessionId: 'sess-1', rowId: 1 });
    const other = buildImportIdempotencyKey({ table: 'observations', sessionId: 'sess-1', rowId: 2 });
    const otherSession = buildImportIdempotencyKey({ table: 'observations', sessionId: 'sess-2', rowId: 1 });
    const otherTable = buildImportIdempotencyKey({ table: 'session_summaries', sessionId: 'sess-1', rowId: 1 });
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(otherSession).not.toBe(first);
    expect(otherTable).not.toBe(first);
  });

  it('renders the structured observation columns into one searchable body', () => {
    const content = renderObservationContent({
      title: 'Worker restart loop',
      subtitle: 'port already bound',
      narrative: 'The worker refused to start because a ghost listener held the port.',
      text: null,
      facts: JSON.stringify(['ghost listener survived the parent', 'port 37777 stayed bound']),
      concepts: JSON.stringify(['worker lifecycle']),
    });
    expect(content).toContain('Worker restart loop');
    expect(content).toContain('- ghost listener survived the parent');
    expect(content).toContain('Concepts:\n- worker lifecycle');
  });
});

/**
 * Mirrors the shape the local worker's SessionStore reaches after its
 * migrations: sdk_sessions plus the widened observations and session_summaries.
 */
function seedLocalDatabase(path: string): void {
  const db = new Database(path, { create: true });
  db.run(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed'
    );

    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );

    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
  `);

  db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch)
     VALUES ('content-1', 'sess-1', 'homelab', 'claude', '2026-09-01T00:00:00Z', 1756684800)`,
  );

  db.run(
    `INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch)
     VALUES ('sess-1', 'homelab', NULL, 'insight', 'Chart values need a schema', 'values.schema.json', ?, 'Helm rejects unknown keys only with a schema.', ?, ?, ?, 1, '2026-09-01T00:01:00Z', 1756684860)`,
    [
      JSON.stringify(['helm lint passes without a schema']),
      JSON.stringify(['helm']),
      JSON.stringify(['charts/claude-mem/values.yaml']),
      JSON.stringify(['charts/claude-mem/values.schema.json']),
    ],
  );

  db.run(
    `INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch)
     VALUES ('sess-1', 'other-repo', 'A plain text observation with no structured columns.', 'note', NULL, '2026-09-01T00:02:00Z', 1756684920)`,
  );

  // Nothing renderable: the import must skip it rather than post empty content.
  db.run(
    `INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
     VALUES ('sess-1', 'homelab', '   ', 'note', '2026-09-01T00:03:00Z', 1756684980)`,
  );

  db.run(
    `INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
     VALUES ('sess-1', 'homelab', 'Ship the import command', 'local schema', 'keys must be deterministic', 'importer written', 'document the restore', ?, ?, NULL, '2026-09-01T00:10:00Z', 1756685400)`,
    [JSON.stringify(['src/services/import/sqlite-import.ts']), JSON.stringify(['tests/import/sqlite-import.test.ts'])],
  );

  db.close();
}
