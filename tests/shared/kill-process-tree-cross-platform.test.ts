import { describe, it, expect, afterAll } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { basename } from 'path';
import {
  killProcessTree,
  collectDescendantIdentities,
  type DescendantIdentity,
} from '../../src/shared/kill-process-tree.js';
import { captureProcessStartToken } from '../../src/shared/process-identity.js';
import { isPidAlive } from '../../src/supervisor/process-registry.js';

/**
 * The parts of tree-kill that are genuinely runnable on BOTH platforms.
 *
 * Most of the reuse suite is `describe.if(isPosix)` — its fixtures depend on
 * `/bin/sh`, `pgrep` and SIGTERM semantics that have no Windows equivalent —
 * so it runs on ubuntu only. That left four Windows-specific mechanisms with
 * no executing coverage anywhere, and they are exactly the ones that cannot be
 * verified locally:
 *
 *   1. the CIM process-table read (descendant discovery),
 *   2. taskkill exit-code classification (not-found tolerated, real failures
 *      surfaced),
 *   3. the root identity gate short-circuiting before `taskkill /T /F`,
 *   4. the descendant reap that runs after `/T` — including on the not-found
 *      branch, where the children are the ones that outlived the root.
 *
 * A format or behaviour difference in any of those would silently skip every
 * descendant as "reused" and bring back #2313 while the code still looked
 * guarded. Everything here therefore uses a platform-appropriate fixture and
 * asserts through the PRODUCTION helpers, so the Windows job exercises the
 * Windows implementations rather than skipping.
 */

const isWindows = process.platform === 'win32';
const strays: number[] = [];

function settle(ms = 600): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await settle(50);
  }
  return predicate();
}

/**
 * A two-level tree on either platform: a shell that outlives a long-running
 * child, so a single-PID kill would leave the child behind.
 */
function spawnTwoLevelTree(): ChildProcess {
  const child = isWindows
    ? spawn('cmd.exe', ['/c', 'ping -n 120 127.0.0.1 > NUL'], { stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', ['-c', 'sleep 120 & wait'], { stdio: 'ignore' });
  if (child.pid) strays.push(child.pid);
  return child;
}

/** The long-running leaf the fixture exists to orphan. */
const payloadImage = isWindows ? 'ping.exe' : 'sleep';

/** Lowercased image name for one PID, or null once it is gone. */
function imageNameOf(pid: number): string | null {
  try {
    if (isWindows) {
      const stdout = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        encoding: 'utf-8',
      });
      const match = stdout.match(/^"([^"]*)"/m);
      return match ? match[1]!.toLowerCase() : null;
    }
    // /proc mirrors what readProcessTableLinux() walks; macOS has no /proc.
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim().toLowerCase();
    return basename(execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' }).trim()).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Enumerate through the production helper, then register every descendant for
 * teardown so a test that only kills the root cannot leak the payload.
 */
async function enumerateDescendants(rootPid: number): Promise<DescendantIdentity[]> {
  const descendants = await collectDescendantIdentities(rootPid);
  for (const entry of descendants) strays.push(entry.pid);
  return descendants;
}

/**
 * The payload descendant, selected by image name.
 *
 * `DescendantIdentity` carries no image name and the walk is a post-order DFS
 * over process-table row order, so index 0 is unspecified by construction. On
 * Windows the `cmd.exe` root has two leaves — `conhost.exe` and `PING.EXE` —
 * and empirically index 0 was the conhost, so `!isPidAlive(descendants[0])`
 * asserted that a console host died while the `ping` this suite exists to
 * catch could still be orphaned.
 */
function payloadPid(descendants: DescendantIdentity[]): number {
  const census = descendants.map(entry => ({ pid: entry.pid, image: imageNameOf(entry.pid) }));
  const match = census.find(entry => entry.image === payloadImage);
  if (!match) {
    const seen = census.map(entry => `${entry.pid}:${entry.image ?? 'gone'}`).join(', ');
    throw new Error(`enumeration found no ${payloadImage} descendant; saw ${seen || '(none)'}`);
  }
  return match.pid;
}

/** PIDs from `pids` still alive after waiting up to `timeoutMs` for all to exit. */
async function survivorsOf(pids: number[], timeoutMs = 20_000): Promise<number[]> {
  await waitUntil(() => pids.every(pid => !isPidAlive(pid)), timeoutMs);
  return pids.filter(pid => isPidAlive(pid));
}

afterAll(() => {
  for (const pid of strays) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

describe('killProcessTree end-to-end on this platform', () => {
  it('discovers descendants through the production enumeration', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    // On Windows this is the CIM read; on POSIX the ps/proc read. Either way it
    // must see the long-running payload, not merely something, or every guard
    // downstream is inert on the process that actually holds the worker port.
    const descendants = await enumerateDescendants(root.pid!);
    expect(isPidAlive(payloadPid(descendants))).toBe(true);

    try { process.kill(root.pid!, 'SIGKILL'); } catch { /* fine */ }
  }, 60_000);

  it('kills the root AND its descendant', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await enumerateDescendants(root.pid!);
    const subtree = [root.pid!, ...descendants.map(entry => entry.pid)];
    expect(subtree).toContain(payloadPid(descendants));

    await killProcessTree(root.pid!);

    // Every enumerated PID, payload included — not whichever one the process
    // table happened to list first.
    expect(await survivorsOf(subtree)).toEqual([]);
  }, 60_000);

  /**
   * Windows-only because the condition is only OBSERVABLE there: Win32_Process
   * keeps a dead parent's ParentProcessId, so an orphan is still discoverable
   * from the root PID. On POSIX the same orphan re-parents to init and drops
   * out of the walk, so no assertion could distinguish reap from short-circuit.
   *
   * The regression: taskkill answers 128 / "no running instance" for a root
   * that is already gone, and that branch used to return success WITHOUT ever
   * enumerating descendants — precisely the case where children outlived the
   * root and may still hold the worker port.
   */
  it.if(isWindows)('reaps a descendant when the root is already gone at call time', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await enumerateDescendants(root.pid!);
    const payload = payloadPid(descendants);

    // No /T: kill ONLY the root, leaving the descendant orphaned and alive.
    execFileSync('taskkill', ['/PID', String(root.pid!), '/F'], { windowsHide: true, stdio: 'ignore' });
    expect(await waitUntil(() => !isPidAlive(root.pid!), 20_000)).toBe(true);
    // The payload specifically: a console host outliving its shell would not
    // hold the worker port, so reaping only that proves nothing.
    expect(isPidAlive(payload)).toBe(true);

    await killProcessTree(root.pid!);

    expect(await survivorsOf(descendants.map(entry => entry.pid))).toEqual([]);
  }, 60_000);

  it('treats an already-dead target as success, not failure', async () => {
    // Windows: taskkill exits 128 / "not found". POSIX: ESRCH. Both are the
    // tolerated case — a throw here would make `server stop` report a failed
    // stop for a server that had already exited.
    const root = spawnTwoLevelTree();
    await settle();
    const pid = root.pid!;

    const descendants = await enumerateDescendants(pid);
    const subtree = [pid, ...descendants.map(entry => entry.pid)];
    expect(subtree).toContain(payloadPid(descendants));

    await killProcessTree(pid);
    // The first call took a LIVE two-level tree, so the descendants are as much
    // its responsibility as the root. Asserting only the root let this test
    // pass against the orphan defect the reap above exists to fix, and left a
    // surviving `ping` behind on every green Windows draw of the soak.
    expect(await survivorsOf(subtree)).toEqual([]);

    // Second call against the corpse must resolve, not reject.
    await killProcessTree(pid);
  }, 60_000);

  it('is a complete no-op when the root identity does not match', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await enumerateDescendants(root.pid!);
    const subtree = [root.pid!, ...descendants.map(entry => entry.pid)];
    expect(subtree).toContain(payloadPid(descendants));

    // A token that cannot belong to this process: the gate must short-circuit
    // BEFORE taskkill /T /F, leaving the subtree untouched.
    await killProcessTree(root.pid!, { expectedStartToken: 'not-this-processes-start-token' });
    await settle(1_000);

    expect(subtree.filter(pid => !isPidAlive(pid))).toEqual([]);

    // Killing only descendants[0] here leaked a `ping` on every soak draw.
    for (const pid of subtree) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* fine */ }
    }
  }, 60_000);

  it('still kills when the supplied root identity matches', async () => {
    // The other half: without this, the no-op case above would pass for a
    // build where the gate rejected everything.
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await enumerateDescendants(root.pid!);
    const subtree = [root.pid!, ...descendants.map(entry => entry.pid)];
    expect(subtree).toContain(payloadPid(descendants));

    const token = captureProcessStartToken(root.pid!);
    expect(token).not.toBeNull();

    await killProcessTree(root.pid!, { expectedStartToken: token });

    expect(await survivorsOf(subtree)).toEqual([]);
  }, 60_000);
});
