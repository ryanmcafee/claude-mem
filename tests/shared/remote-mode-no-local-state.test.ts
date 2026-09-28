// SPDX-License-Identifier: Apache-2.0
//
// MCAA-237 acceptance: remote mode leaves no local worker process and no local
// database behind. These drive the two real entry points — the worker spawner
// and the SQLite connection factory — with a temp data dir, then assert the
// directory is still empty afterwards.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureWorkerStarted } from '../../src/services/worker-spawner.js';
import { openConfiguredSqliteDatabase } from '../../src/services/sqlite/connection.js';
import { RemoteModeLocalStorageError } from '../../src/shared/remote-mode.js';
import { ensureWorkerRunning } from '../../src/shared/worker-utils.js';
import { logger } from '../../src/utils/logger.js';

describe('MCAA-237 — remote mode leaves no local state', () => {
  let dataDir: string;
  let savedEnv: Record<string, string | undefined>;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    dataDir = mkdtempSync(join(tmpdir(), 'cmem-remote-mode-'));
    savedEnv = {
      CLAUDE_MEM_DATA_DIR: process.env.CLAUDE_MEM_DATA_DIR,
      CLAUDE_MEM_SERVER_URL: process.env.CLAUDE_MEM_SERVER_URL,
      CLAUDE_MEM_API_KEY: process.env.CLAUDE_MEM_API_KEY,
      CLAUDE_MEM_PROJECT_ID: process.env.CLAUDE_MEM_PROJECT_ID,
    };
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    process.env.CLAUDE_MEM_SERVER_URL = 'https://claude-mem.example.com';
    process.env.CLAUDE_MEM_API_KEY = 'cm_remote_mode_test';
    process.env.CLAUDE_MEM_PROJECT_ID = 'homelab';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
    for (const spy of loggerSpies) spy.mockRestore();
    loggerSpies = [];
  });

  it('does not spawn a worker, and writes no pid or lock file', async () => {
    const result = await ensureWorkerStarted(31999, join(dataDir, 'worker-service.cjs'));
    expect(result).toBe('remote');
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('reports no worker to the hook path instead of starting one', async () => {
    expect(await ensureWorkerRunning()).toBe(false);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('refuses to create the local memory database', () => {
    const dbPath = join(dataDir, 'claude-mem.db');
    expect(() => openConfiguredSqliteDatabase(dbPath)).toThrow(RemoteModeLocalStorageError);
    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('names the env var to unset in the failure message', () => {
    try {
      openConfiguredSqliteDatabase(join(dataDir, 'claude-mem.db'));
      throw new Error('expected a RemoteModeLocalStorageError');
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteModeLocalStorageError);
      expect((error as Error).message).toContain('CLAUDE_MEM_SERVER_URL');
    }
  });

  it('still creates the database once remote mode is switched off', () => {
    delete process.env.CLAUDE_MEM_SERVER_URL;
    delete process.env.CLAUDE_MEM_API_KEY;
    delete process.env.CLAUDE_MEM_PROJECT_ID;
    const dbPath = join(dataDir, 'claude-mem.db');
    const db = openConfiguredSqliteDatabase(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      db.close();
    }
  });
});
