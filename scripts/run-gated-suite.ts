#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//
// Runs every suite that reads a given CLAUDE_MEM_TEST_* gate and fails if any
// of them skipped. A gated suite that skips reads as coverage without being
// coverage, so silence here is treated as a failure rather than a pass.

import path from 'path';
import { findGate, suitesForGate, summarizeBunTestOutput } from './test-gates.js';

const repoRoot = path.resolve(import.meta.dir, '..');

function fail(message: string): never {
  console.error(`run-gated-suite: ${message}`);
  process.exit(1);
}

const [gateEnv, ...passthrough] = process.argv.slice(2);

if (!gateEnv) {
  fail(`usage: bun ${path.relative(repoRoot, import.meta.path)} <GATE_ENV_VAR> [bun test args...]`);
}

if (!findGate(gateEnv)) {
  fail(`${gateEnv} is not a registered gate. Add it to TEST_GATES in scripts/test-gates.ts.`);
}

const gateValue = process.env[gateEnv];
if (!gateValue) {
  fail(
    `${gateEnv} is unset, so every suite for this gate would skip. ` +
      `Set it in the job that invokes this runner.`,
  );
}

const suites = suitesForGate(repoRoot, gateEnv);
if (suites.length === 0) {
  fail(`no suite under tests/ reads ${gateEnv}. Remove the gate from TEST_GATES or the runner call.`);
}

console.log(`run-gated-suite: ${gateEnv} -> ${suites.length} suite(s)`);
for (const suite of suites) console.log(`  ${suite}`);

const child = Bun.spawn(['bun', 'test', ...suites, ...passthrough], {
  cwd: repoRoot,
  stdout: 'pipe',
  stderr: 'pipe',
  env: process.env,
});

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);

process.stdout.write(stdout);
process.stderr.write(stderr);

const { passed, skipped } = summarizeBunTestOutput(`${stdout}\n${stderr}`);

if (exitCode !== 0) {
  fail(`bun test exited ${exitCode} for ${gateEnv}`);
}

if (skipped > 0) {
  fail(
    `${skipped} test(s) skipped while ${gateEnv} was set. ` +
      `A gated suite that skips in its own job is not coverage — fix the gate or delete the suite.`,
  );
}

if (passed === 0) {
  fail(`no test passed for ${gateEnv}; the suites did not execute.`);
}

console.log(`run-gated-suite: ${gateEnv} — ${passed} passed, 0 skipped across ${suites.length} suite(s)`);
