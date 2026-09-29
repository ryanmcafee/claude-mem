import { describe, it, expect, afterEach } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectDescendantIdentities } from '../../src/shared/kill-process-tree.js';
import { captureProcessStartToken } from '../../src/shared/process-identity.js';

/**
 * Tests for scripts/tree-kill-survivor-census.ts, the gate that decides whether
 * a tree-kill draw left a process behind and which test to charge it to.
 *
 * It exists because the tree-kill suite can pass while leaking: every green
 * draw of the MCAA-380 soak orphaned two `ping -n 120` trees and no assertion
 * could see them. A gate that can only ever report zero is worth nothing, so
 * each arm below is pinned: a live ledger PID is reported and named, an allowed
 * test is tolerated, a reaped tree reports nothing, a reissued PID is not
 * charged to the test that once owned it, and an empty ledger fails instead of
 * reading as clean.
 */

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'tree-kill-survivor-census.ts');
const isWindows = process.platform === 'win32';
const OWNER = 'a test that must not leak';

function spawnTwoLevelTree(): ChildProcess {
  return isWindows
    ? spawn('cmd.exe', ['/c', 'ping -n 120 127.0.0.1 > NUL'], { stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', ['-c', 'sleep 120 & wait'], { stdio: 'ignore' });
}

function settle(ms = 600): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('tree-kill survivor census', () => {
  const workspaces: string[] = [];
  const spawned: number[] = [];

  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A census run over a ledger written from `records`. */
  function census(records: object[], allow: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-census-'));
    workspaces.push(dir);
    const ledger = join(dir, 'pids.jsonl');
    const out = join(dir, 'survivors.log');
    const json = join(dir, 'survivors.json');
    writeFileSync(ledger, records.map(record => JSON.stringify(record)).join('\n'));

    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--ledger', ledger,
      '--out', out,
      '--json', json,
      ...allow.flatMap(name => ['--allow', name]),
    ], { encoding: 'utf-8' });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      log: readFileSync(out, 'utf-8'),
      report: JSON.parse(readFileSync(json, 'utf-8')) as {
        reused: number[];
        survivors: { pid: number; test: string; via: string; allowed: boolean }[];
      },
    };
  }

  it('names the test a surviving process belongs to, and fails', async () => {
    const root = spawnTwoLevelTree();
    spawned.push(root.pid!);
    await settle();

    const result = census([
      { test: OWNER, role: 'root', pid: root.pid!, startToken: captureProcessStartToken(root.pid!) },
    ]);

    expect(result.status).toBe(1);
    expect(result.report.survivors.map(entry => entry.test)).toContain(OWNER);
    expect(result.log).toContain(`UNEXPECTED pid=${root.pid!}`);
    expect(result.stderr).toContain(`left by "${OWNER}"`);
  }, 30_000);

  it('attributes a descendant through its parent chain', async () => {
    const root = spawnTwoLevelTree();
    spawned.push(root.pid!);
    await settle();
    const descendants = await collectDescendantIdentities(root.pid!);
    for (const entry of descendants) spawned.push(entry.pid);
    expect(descendants.length).toBeGreaterThan(0);

    // Only the ROOT is in the ledger: the descendants have to be reached by
    // walking up from them, which is the arm that attributes a Windows orphan
    // whose `cmd.exe` parent is already dead.
    const result = census([
      { test: OWNER, role: 'root', pid: root.pid!, startToken: captureProcessStartToken(root.pid!) },
    ]);

    const viaAncestor = result.report.survivors.filter(entry => entry.via.startsWith('ancestor'));
    expect(viaAncestor.length).toBeGreaterThan(0);
    expect(viaAncestor.every(entry => entry.test === OWNER)).toBe(true);
  }, 30_000);

  it('tolerates a survivor whose test is allowed to leave one', async () => {
    const root = spawnTwoLevelTree();
    spawned.push(root.pid!);
    await settle();

    const result = census(
      [{ test: OWNER, role: 'root', pid: root.pid!, startToken: captureProcessStartToken(root.pid!) }],
      [OWNER]
    );

    expect(result.status).toBe(0);
    expect(result.report.survivors.every(entry => entry.allowed)).toBe(true);
    expect(result.log).toContain(`ALLOWED   pid=${root.pid!}`);
  }, 30_000);

  it('reports nothing when the ledger PIDs are all gone', async () => {
    const root = spawnTwoLevelTree();
    const rootPid = root.pid!;
    const startToken = captureProcessStartToken(rootPid);
    await settle();
    const descendants = await collectDescendantIdentities(rootPid);
    for (const entry of [rootPid, ...descendants.map(entry => entry.pid)]) {
      try { process.kill(entry, 'SIGKILL'); } catch { /* already gone */ }
    }
    await settle();

    const result = census([
      { test: OWNER, role: 'root', pid: rootPid, startToken },
      ...descendants.map(entry => ({ test: OWNER, role: 'descendant', pid: entry.pid, startToken: entry.startToken })),
    ]);

    expect(result.status).toBe(0);
    expect(result.report.survivors).toEqual([]);
  }, 30_000);

  it('does not charge a reissued PID to the test that once owned it', async () => {
    const root = spawnTwoLevelTree();
    spawned.push(root.pid!);
    await settle();

    // Same live PID, a token it cannot have produced: the number no longer
    // names the process the ledger recorded, so the leak is not this test's.
    const result = census([
      { test: OWNER, role: 'root', pid: root.pid!, startToken: 'not-a-token-this-process-produced' },
    ]);

    expect(result.status).toBe(0);
    expect(result.report.reused).toContain(root.pid!);
    expect(result.report.survivors.map(entry => entry.pid)).not.toContain(root.pid!);
    expect(result.log).toContain(`reissued since, not charged to their test: ${root.pid!}`);
  }, 30_000);

  it('fails on an empty ledger instead of reporting a clean draw', () => {
    const result = census([]);

    expect(result.status).toBe(1);
    expect(result.report.survivors).toEqual([]);
    expect(result.stderr).toContain('holds no root record');
  });
});
