#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//
// Fails a PR that drops a test title from a gated suite (MCAA-395).
//
// Taking one side of a conflicted test file wholesale compiles, keeps the file
// present, and keeps the suite green — the assertions are just fewer. Both
// confirmed instances were caught only by simulating the merge order by hand.
// Comparing each changed gated suite's titles against the merge base turns that
// silence into a red build.

import path from 'path';
import {
  TESTS_REMOVED_LABEL,
  collectTestNames,
  diffTestNames,
  isWaived,
  parseLabels,
  parseRemovalWaivers,
  type RemovedTest,
} from './test-names.js';
import { findGate, gatesInSource } from './test-gates.js';

const repoRoot = path.resolve(import.meta.dir, '..');

function git(args: string[], allowFailure = false): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    if (allowFailure) return '';
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout);
}

/** Empty string for a path that does not exist at that revision. */
function fileAt(revision: string, file: string): string {
  return git(['show', `${revision}:${file}`], true);
}

function resolveBaseRef(): string {
  const explicit = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  if (explicit) return explicit;
  const baseRef = process.env.GITHUB_BASE_REF;
  return baseRef ? `origin/${baseRef}` : 'origin/main';
}

const baseRef = resolveBaseRef();
const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();

if (!mergeBase) {
  console.error(`check-test-name-removals: no merge base between ${baseRef} and HEAD`);
  process.exit(1);
}

console.log(`check-test-name-removals: base ${baseRef} (merge-base ${mergeBase.slice(0, 12)})`);

interface ChangedFile {
  readonly basePath: string;
  readonly headPath: string | undefined;
}

/**
 * `-M` so a renamed suite is compared against its old path instead of reading as
 * a wholesale delete plus an unrelated add.
 */
function changedTestFiles(): ChangedFile[] {
  const raw = git(['diff', '--name-status', '-M', '--diff-filter=MDR', `${mergeBase}..HEAD`, '--', 'tests']);
  const files: ChangedFile[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [status, first, second] = line.split('\t');
    if (!first?.endsWith('.test.ts')) continue;

    if (status.startsWith('R')) {
      files.push({ basePath: first, headPath: second });
    } else if (status === 'D') {
      files.push({ basePath: first, headPath: undefined });
    } else {
      files.push({ basePath: first, headPath: first });
    }
  }

  return files;
}

interface Finding {
  readonly basePath: string;
  readonly headPath: string | undefined;
  readonly removed: readonly RemovedTest[];
}

const findings: Finding[] = [];
let inspected = 0;

for (const file of changedTestFiles()) {
  const baseSource = fileAt(mergeBase, file.basePath);
  if (!baseSource) continue;

  const headSource = file.headPath ? fileAt('HEAD', file.headPath) : '';

  // Scoped to the gates scripts/test-gates.ts enumerates, so this composes with
  // the silent-gate check rather than policing every suite in the repo.
  const gates = [...new Set([...gatesInSource(baseSource), ...gatesInSource(headSource)])];
  if (!gates.some((gate) => findGate(gate) !== undefined)) continue;

  inspected += 1;
  const removed = diffTestNames(
    collectTestNames(baseSource, file.basePath),
    collectTestNames(headSource, file.headPath ?? file.basePath),
  );

  if (removed.length > 0) {
    findings.push({ basePath: file.basePath, headPath: file.headPath, removed });
  }
}

console.log(`check-test-name-removals: inspected ${inspected} changed gated suite(s)`);

if (findings.length === 0) {
  console.log('check-test-name-removals: no test titles removed');
  process.exit(0);
}

const labels = parseLabels(process.env.PR_LABELS);
const labelled = labels.includes(TESTS_REMOVED_LABEL);
const waivers = parseRemovalWaivers(git(['log', '--format=%B', `${mergeBase}..HEAD`]));

const unwaived: string[] = [];

for (const finding of findings) {
  const location = finding.headPath
    ? finding.basePath
    : `${finding.basePath} (file deleted)`;
  console.error(`\n${location}`);

  for (const removal of finding.removed) {
    const scope = removal.describePath.length > 0 ? ` [${removal.describePath.join(' > ')}]` : '';
    const counts = removal.headCount > 0 ? ` (${removal.baseCount} -> ${removal.headCount})` : '';
    const waived = labelled || isWaived(removal.title, waivers);
    console.error(`  ${waived ? 'waived ' : 'REMOVED'} "${removal.title}"${scope}${counts}`);
    if (!waived) unwaived.push(`${location}: "${removal.title}"`);
  }
}

if (unwaived.length === 0) {
  const via = labelled ? `the "${TESTS_REMOVED_LABEL}" label` : 'Removed-test: commit trailers';
  console.log(`\ncheck-test-name-removals: ${findings.length} file(s) removed tests, all declared via ${via}`);
  process.exit(0);
}

console.error(
  [
    '',
    `check-test-name-removals: ${unwaived.length} test title(s) removed from a gated suite without declaring it.`,
    '',
    'A conflict resolution that takes one side of a test file wholesale drops the other',
    "side's assertions while the suite still passes. If the removal is intended — including",
    'a deliberate rename, since a title is the only identity a test has — declare it:',
    '',
    `  - label the PR "${TESTS_REMOVED_LABEL}", or`,
    '  - add a commit trailer naming each removal and why:',
    '      Removed-test: "<exact test title>" replaced by <what covers it now>',
    '',
    'Otherwise restore the missing tests — re-derive where they belong rather than',
    'pasting them back by line position.',
  ].join('\n'),
);
process.exit(1);
