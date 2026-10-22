import { describe, it, expect, afterAll } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { killProcessTree, collectDescendantIdentities } from '../../src/shared/kill-process-tree.js';
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

afterAll(() => {
  for (const pid of strays) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

describe('killProcessTree end-to-end on this platform', () => {
  it('discovers descendants through the production enumeration', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    // On Windows this is the CIM read; on POSIX the ps/proc read. Either way
    // it must actually see the child, or every guard downstream is inert.
    const descendants = await collectDescendantIdentities(root.pid!);
    expect(descendants.length).toBeGreaterThan(0);

    try { process.kill(root.pid!, 'SIGKILL'); } catch { /* fine */ }
  }, 60_000);

  it('kills the root AND its descendant', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await collectDescendantIdentities(root.pid!);
    expect(descendants.length).toBeGreaterThan(0);
    const childPid = descendants[0]!.pid;

    await killProcessTree(root.pid!);

    expect(await waitUntil(() => !isPidAlive(root.pid!), 20_000)).toBe(true);
    expect(await waitUntil(() => !isPidAlive(childPid), 20_000)).toBe(true);
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

    const descendants = await collectDescendantIdentities(root.pid!);
    expect(descendants.length).toBeGreaterThan(0);
    const childPid = descendants[0]!.pid;

    // No /T: kill ONLY the root, leaving the descendant orphaned and alive.
    execFileSync('taskkill', ['/PID', String(root.pid!), '/F'], { windowsHide: true, stdio: 'ignore' });
    expect(await waitUntil(() => !isPidAlive(root.pid!), 20_000)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    await killProcessTree(root.pid!);

    expect(await waitUntil(() => !isPidAlive(childPid), 20_000)).toBe(true);
  }, 60_000);

  it('treats an already-dead target as success, not failure', async () => {
    // Windows: taskkill exits 128 / "not found". POSIX: ESRCH. Both are the
    // tolerated case — a throw here would make `server stop` report a failed
    // stop for a server that had already exited.
    const root = spawnTwoLevelTree();
    await settle();
    const pid = root.pid!;

    const descendants = await collectDescendantIdentities(pid);
    expect(descendants.length).toBeGreaterThan(0);
    const childPid = descendants[0]!.pid;

    await killProcessTree(pid);
    expect(await waitUntil(() => !isPidAlive(pid), 20_000)).toBe(true);
    // The first call took a LIVE two-level tree, so the descendant is as much
    // its responsibility as the root. Asserting only the root let this test
    // pass against the orphan defect the reap above exists to fix, and left a
    // surviving `ping` behind on every green Windows draw of the soak.
    expect(await waitUntil(() => !isPidAlive(childPid), 20_000)).toBe(true);

    // Second call against the corpse must resolve, not reject.
    await killProcessTree(pid);
  }, 60_000);

  it('is a complete no-op when the root identity does not match', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await collectDescendantIdentities(root.pid!);
    expect(descendants.length).toBeGreaterThan(0);
    const childPid = descendants[0]!.pid;

    // A token that cannot belong to this process: the gate must short-circuit
    // BEFORE taskkill /T /F, leaving the subtree untouched.
    await killProcessTree(root.pid!, { expectedStartToken: 'not-this-processes-start-token' });
    await settle(1_000);

    expect(isPidAlive(root.pid!)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    try { process.kill(root.pid!, 'SIGKILL'); } catch { /* fine */ }
    try { process.kill(childPid, 'SIGKILL'); } catch { /* fine */ }
  }, 60_000);

  it('still kills when the supplied root identity matches', async () => {
    // The other half: without this, the no-op case above would pass for a
    // build where the gate rejected everything.
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await collectDescendantIdentities(root.pid!);
    expect(descendants.length).toBeGreaterThan(0);
    const childPid = descendants[0]!.pid;

    const token = captureProcessStartToken(root.pid!);
    expect(token).not.toBeNull();

    await killProcessTree(root.pid!, { expectedStartToken: token });

    expect(await waitUntil(() => !isPidAlive(root.pid!), 20_000)).toBe(true);
    expect(await waitUntil(() => !isPidAlive(childPid), 20_000)).toBe(true);
  }, 60_000);
});
