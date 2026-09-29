#!/usr/bin/env bun
/**
 * Attribute every process the tree-kill suite left running to the test that
 * created it, and fail when a test that is not allowed to leak one did.
 *
 * `tests/shared/kill-process-tree-cross-platform.test.ts` writes a JSONL
 * ledger (CLAUDE_MEM_TREE_KILL_PID_LEDGER) naming, per test, every fixture
 * root it spawned and every descendant the production enumeration returned.
 * This reads the process table afterwards and joins the two, so a surviving
 * `ping -n 120` is reported as "left by <test name>" rather than counted.
 *
 * Attribution has two arms because orphans behave differently per platform:
 *
 *   - direct: the survivor's own PID is in the ledger.
 *   - ancestor: the survivor's parent chain reaches a ledger PID. Windows
 *     keeps a dead parent's ParentProcessId, so a `ping` whose `cmd.exe` is
 *     already gone still names it. On POSIX the same orphan re-parents to
 *     init, which is why the ledger records enumerated descendants too.
 *
 * Either arm can name a PID the OS has since reissued -- Windows recycles PIDs
 * aggressively -- so a ledger entry is only believed while the production
 * isSameProcess() predicate still says the number means what it meant. A reused
 * number is reported as reused rather than charged to the test as a leak.
 *
 * Exits 1 when a survivor belongs to a test outside --allow, and also when the
 * ledger holds no root record at all: a census over an empty ledger reports
 * zero survivors for a suite that never ran, which is not evidence of anything.
 */

import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { isSameProcess } from '../src/shared/process-identity.js';

interface ProcessRow {
  pid: number;
  ppid: number;
  image: string;
  commandLine: string;
}

interface LedgerEntry {
  test: string;
  role: 'root' | 'descendant';
  pid: number;
  startToken: string | null;
}

interface Survivor {
  pid: number;
  ppid: number;
  image: string;
  commandLine: string;
  test: string;
  via: string;
  allowed: boolean;
}

interface Options {
  ledger: string;
  out: string;
  json: string | null;
  allow: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = { ledger: '', out: 'survivors.log', json: null, allow: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--ledger') options.ledger = value;
    else if (flag === '--out') options.out = value;
    else if (flag === '--json') options.json = value;
    else if (flag === '--allow') options.allow.push(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.ledger) throw new Error('--ledger <path> is required');
  return options;
}

function readLedger(path: string): LedgerEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Partial<LedgerEntry>;
    if (typeof record.pid !== 'number' || typeof record.test !== 'string') continue;
    entries.push({
      test: record.test,
      role: record.role === 'root' ? 'root' : 'descendant',
      pid: record.pid,
      startToken: typeof record.startToken === 'string' ? record.startToken : null,
    });
  }
  return entries;
}

function readProcessTableWindows(): ProcessRow[] {
  const stdout = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2",
    ],
    { windowsHide: true, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
  );
  const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row): ProcessRow[] => {
    const record = row as { ProcessId?: number; ParentProcessId?: number; Name?: string; CommandLine?: string };
    if (typeof record.ProcessId !== 'number') return [];
    return [{
      pid: record.ProcessId,
      ppid: typeof record.ParentProcessId === 'number' ? record.ParentProcessId : 0,
      image: record.Name ?? '',
      commandLine: record.CommandLine ?? '',
    }];
  });
}

function readProcessTableLinux(): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf-8');
    } catch {
      continue;
    }
    const tailStart = stat.lastIndexOf(') ');
    if (tailStart < 0) continue;
    const ppid = Number.parseInt(stat.slice(tailStart + 2).split(' ')[1] ?? '', 10);
    if (!Number.isFinite(ppid)) continue;
    let commandLine = '';
    try {
      commandLine = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
    } catch { /* exited mid-read */ }
    rows.push({
      pid: Number.parseInt(entry, 10),
      ppid,
      image: stat.slice(stat.indexOf('(') + 1, tailStart),
      commandLine,
    });
  }
  return rows;
}

function readProcessTablePosix(): ProcessRow[] {
  const stdout = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      image: match[3]!,
      commandLine: match[4]!,
    });
  }
  return rows;
}

function readProcessTable(): ProcessRow[] {
  if (process.platform === 'win32') return readProcessTableWindows();
  if (process.platform === 'linux') return readProcessTableLinux();
  return readProcessTablePosix();
}

/** The ledger PID reached from `row`, either itself or up its parent chain. */
function attribute(
  row: ProcessRow,
  owners: Map<number, LedgerEntry>,
  byPid: Map<number, ProcessRow>,
  reused: Set<number>
): { test: string; via: string } | null {
  const claim = (entry: LedgerEntry, via: string): { test: string; via: string } | null => {
    if (isSameProcess(entry.pid, entry.startToken)) return { test: entry.test, via };
    reused.add(entry.pid);
    return null;
  };

  const direct = owners.get(row.pid);
  if (direct) return claim(direct, 'direct');

  const seen = new Set<number>([row.pid]);
  let ancestor = row.ppid;
  while (ancestor > 1 && !seen.has(ancestor)) {
    seen.add(ancestor);
    const owner = owners.get(ancestor);
    if (owner) return claim(owner, `ancestor ${ancestor}`);
    const parent = byPid.get(ancestor);
    if (!parent) return null;
    ancestor = parent.ppid;
  }
  return null;
}

function render(survivors: Survivor[], ledger: LedgerEntry[], allow: string[], reused: Set<number>): string {
  const lines = [
    `platform: ${process.platform}`,
    `ledger: ${ledger.length} records (${ledger.filter(entry => entry.role === 'root').length} roots) across ${new Set(ledger.map(entry => entry.test)).size} tests`,
    `allowed to leave survivors: ${allow.length ? allow.map(name => `"${name}"`).join(', ') : '(none)'}`,
    `survivors: ${survivors.length} (${survivors.filter(entry => !entry.allowed).length} unexpected)`,
    `ledger PIDs the OS has reissued since, not charged to their test: ${reused.size ? [...reused].join(', ') : 'none'}`,
    '',
  ];
  if (!survivors.length) lines.push('no suite-owned process is still running');
  for (const survivor of survivors) {
    lines.push(
      `${survivor.allowed ? 'ALLOWED  ' : 'UNEXPECTED'} pid=${survivor.pid} ppid=${survivor.ppid} image=${survivor.image}`,
      `           test: ${survivor.test}`,
      `           attributed: ${survivor.via}`,
      `           command: ${survivor.commandLine || '(unavailable)'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const ledger = readLedger(options.ledger);
  const owners = new Map<number, LedgerEntry>();
  for (const entry of ledger) owners.set(entry.pid, entry);

  const table = readProcessTable();
  const byPid = new Map(table.map(row => [row.pid, row]));
  const reused = new Set<number>();
  const survivors: Survivor[] = [];
  for (const row of table) {
    if (row.pid === process.pid) continue;
    const owner = attribute(row, owners, byPid, reused);
    if (!owner) continue;
    survivors.push({ ...row, test: owner.test, via: owner.via, allowed: options.allow.includes(owner.test) });
  }

  const report = render(survivors, ledger, options.allow, reused);
  writeFileSync(options.out, report);
  if (options.json) {
    writeFileSync(
      options.json,
      `${JSON.stringify({ platform: process.platform, allow: options.allow, reused: [...reused], survivors }, null, 2)}\n`
    );
  }
  process.stdout.write(report);

  if (!ledger.some(entry => entry.role === 'root')) {
    process.stderr.write(
      `\nLedger ${options.ledger} holds no root record: the suite either never ran or ran without\n` +
      'CLAUDE_MEM_TREE_KILL_PID_LEDGER set. A census over an empty ledger cannot report a survivor.\n'
    );
    return 1;
  }

  const unexpected = survivors.filter(survivor => !survivor.allowed);
  if (unexpected.length) {
    process.stderr.write(`\n${unexpected.length} process(es) survived a test that must not leak one:\n`);
    for (const survivor of unexpected) {
      process.stderr.write(`  pid ${survivor.pid} (${survivor.image}) left by "${survivor.test}"\n`);
    }
    return 1;
  }
  return 0;
}

process.exit(main());
