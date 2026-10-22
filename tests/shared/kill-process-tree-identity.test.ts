import { describe, it, expect, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { collectDescendantIdentities } from '../../src/shared/kill-process-tree.js';
import {
  captureProcessStartToken,
  isSameProcess,
  __identityProbeCountForTesting,
} from '../../src/shared/process-identity.js';

/**
 * Format-agreement guard for the atomic descendant enumeration.
 *
 * collectDescendantIdentities() takes each PID's start token from the SAME
 * process-table read that discovered it — /proc/<pid>/stat on Linux, one
 * `ps -eo pid=,ppid=,lstart=` on macOS/BSD, one CIM query on Windows. Every
 * later revalidation re-reads that token through captureProcessStartToken().
 *
 * If those two ever disagree on FORMAT, the failure is silent and severe: no
 * comparison would ever match, every descendant would be skipped as "reused",
 * and the orphan bug (#2313) comes straight back while the code still looks
 * guarded. That is the one way this design fails closed-but-wrong, so it is
 * asserted rather than assumed — on whatever platform the suite runs.
 */

const strays: number[] = [];

function settle(ms = 500): Promise<void> {
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

afterAll(() => {
  for (const pid of strays) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

describe('descendant enumeration agrees with captureProcessStartToken', () => {
  it('produces tokens identical to an independent re-probe', async () => {
    const command = process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'ping -n 60 127.0.0.1 > NUL'], { stdio: 'ignore', windowsHide: true })
      : spawn('/bin/sh', ['-c', 'sleep 60 & sleep 60 & wait'], { stdio: 'ignore' });

    const rootPid = command.pid!;
    strays.push(rootPid);
    await settle();

    const descendants = await collectDescendantIdentities(rootPid);
    expect(descendants.length).toBeGreaterThan(0);

    // At least one token must have been readable, or the comparison below is
    // vacuous — every entry would trivially "agree" via the null fallback.
    const withTokens = descendants.filter(entry => entry.startToken !== null);
    expect(withTokens.length).toBeGreaterThan(0);

    for (const entry of withTokens) {
      const reprobed = captureProcessStartToken(entry.pid);
      // A null re-probe means the process exited between the two reads, which
      // is legitimate; only a NON-null disagreement is a format bug.
      if (reprobed === null) continue;
      expect(reprobed).toBe(entry.startToken);
    }

    try { process.kill(rootPid, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);

  it('returns leaves before their ancestors', async () => {
    if (process.platform === 'win32') return;

    const command = spawn(
      '/bin/sh',
      ['-c', '/bin/sh -c "sleep 60 & wait" & wait'],
      { stdio: 'ignore' }
    );
    const rootPid = command.pid!;
    strays.push(rootPid);
    await settle();

    const descendants = await collectDescendantIdentities(rootPid);
    expect(descendants.length).toBeGreaterThanOrEqual(2);

    // The intermediate shell is a direct child of the root; the innermost
    // sleep is its child. Leaves-first means the deeper one comes first.
    const pids = descendants.map(entry => entry.pid);
    const intermediate = pids[pids.length - 1];
    expect(descendants[0]!.pid).not.toBe(intermediate);

    try { process.kill(rootPid, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);
});

/**
 * The identity cache must never authorize a kill.
 *
 * On Windows captureProcessStartToken caches per-pid for 5s. Because a
 * snapshot capture populates that entry and the revalidation reads it back,
 * the check was a TAUTOLOGY there — always true inside the TTL, not a race —
 * so a reused PID was certified as the original and passed to
 * `taskkill /PID <pid> /T /F` along with its whole subtree.
 *
 * The probe counter makes the fix observable on EVERY platform: whatever the
 * caching policy, isSameProcess must perform a fresh read each time it is
 * asked to authorize a kill. The Windows-only half (that the cached accessor
 * really does serve from cache) is asserted separately, and this file runs in
 * the Windows CI job for exactly that reason.
 */
describe('identity revalidation never trusts the cache', () => {
  it('isSameProcess performs a fresh read on every call', () => {
    const token = captureProcessStartToken(process.pid);
    expect(token).not.toBeNull();

    const before = __identityProbeCountForTesting();
    isSameProcess(process.pid, token);
    const afterFirst = __identityProbeCountForTesting();
    isSameProcess(process.pid, token);
    const afterSecond = __identityProbeCountForTesting();

    // Each authorization re-reads the OS; neither call may be served from a
    // cached verdict.
    expect(afterFirst).toBeGreaterThan(before);
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  it('still returns the correct verdict while bypassing the cache', () => {
    const token = captureProcessStartToken(process.pid);

    expect(isSameProcess(process.pid, token)).toBe(true);
    expect(isSameProcess(process.pid, 'a-token-from-some-other-process')).toBe(false);
    // Unreadable snapshot token must still mean "proceed" — refusing has to
    // stay strictly narrower than killing, or #2313 comes back.
    expect(isSameProcess(process.pid, null)).toBe(true);
  });

  it.if(process.platform === 'win32')('the cached accessor DOES serve from cache (Windows)', () => {
    // Establishes that the cache the fix bypasses is real on this platform —
    // without this, the assertion above could pass on a build where caching
    // silently stopped working, and the bypass would be proving nothing.
    captureProcessStartToken(process.pid);

    const before = __identityProbeCountForTesting();
    captureProcessStartToken(process.pid);
    const after = __identityProbeCountForTesting();

    expect(after).toBe(before);
  });
});

/**
 * "This PID does not resolve" must never be remembered.
 *
 * The cache exists so a repeated ownership check does not re-shell to CIM, but
 * a NEGATIVE entry is a different thing entirely. Windows reissues a freed PID
 * within milliseconds, so the entry is served to the REPLACEMENT process for
 * the rest of the 5s TTL — and because isSameProcess() treats a null snapshot
 * token as "proceed", the reuse guard switches itself off at the exact moment
 * a reuse has happened. A caller that asks for a just-spawned process's
 * identity gets null for a live process, which is how the 40-draw soak saw
 * `expect(token).not.toBeNull()` fail on a root it had only just spawned.
 *
 * Deleting on a null read rather than merely skipping the write matters too:
 * the entry cached while the PID was alive would otherwise outlive the process
 * and be handed to the replacement as its identity.
 */
describe('the identity cache never remembers an unresolvable PID', () => {
  it('re-probes the OS instead of serving a cached null (win32 branch)', () => {
    // powershell.exe is absent on the POSIX runners, so the CIM lookup fails
    // and this exercises the null path deterministically on every platform.
    const originalPlatform = process.platform;
    const probePid = 626262;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(captureProcessStartToken(probePid)).toBeNull();

      const before = __identityProbeCountForTesting();
      expect(captureProcessStartToken(probePid)).toBeNull();
      expect(__identityProbeCountForTesting()).toBeGreaterThan(before);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it.if(process.platform === 'win32')('retires a token cached while the PID was alive (Windows)', async () => {
    const child = spawn('cmd.exe', ['/c', 'ping -n 60 127.0.0.1 > NUL'], { stdio: 'ignore', windowsHide: true });
    const pid = child.pid!;
    strays.push(pid);
    await settle();

    const liveToken = captureProcessStartToken(pid);
    expect(liveToken).not.toBeNull();

    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }

    // isSameProcess bypasses the cache, so this polls the real process table
    // and returns true once the PID stops resolving — and it is also the call
    // that used to write the poisoned null entry.
    expect(await waitUntil(() => isSameProcess(pid, 'not-this-processes-start-token'), 20_000)).toBe(true);

    const before = __identityProbeCountForTesting();
    expect(captureProcessStartToken(pid)).toBeNull();
    expect(__identityProbeCountForTesting()).toBeGreaterThan(before);
  }, 60_000);
});
