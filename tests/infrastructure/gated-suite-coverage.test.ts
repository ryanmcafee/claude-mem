// SPDX-License-Identifier: Apache-2.0
//
// An env-gated suite that no CI job supplies the gate for reports green forever
// without executing. The failure mode is silence, so nothing surfaces it until
// someone edits the file for an unrelated reason (MCAA-344). These assertions
// turn that silence into a build failure.

import { describe, it, expect } from 'bun:test';
import path from 'path';
import {
  GATE_RUNNER_ENTRYPOINT,
  TEST_GATES,
  discoverGatedSuites,
  expandPackageScripts,
  findGate,
  loadPackageScripts,
  loadWorkflowSteps,
  stepsSupplyingGate,
  summarizeBunTestOutput,
} from '../../scripts/test-gates.js';

const repoRoot = path.resolve(__dirname, '../..');

const gatedSuites = discoverGatedSuites(repoRoot);
const packageScripts = loadPackageScripts(repoRoot);
const workflowSteps = loadWorkflowSteps(repoRoot);

const expandedSteps = workflowSteps.map((step) => ({
  ...step,
  expandedRun: expandPackageScripts(step.run, packageScripts),
}));

function describeStep(step: { workflow: string; job: string; name: string }): string {
  return `${step.workflow} / ${step.job} / ${step.name}`;
}

describe('env-gated test suites are executed by a CI job', () => {
  it('discovers the gated suites it is meant to police', () => {
    expect(gatedSuites.length).toBeGreaterThan(0);
  });

  it('registers every CLAUDE_MEM_TEST_* gate read under tests/', () => {
    const unregistered = gatedSuites
      .flatMap((suite) => suite.gates.map((gate) => ({ gate, file: suite.file })))
      .filter((entry) => findGate(entry.gate) === undefined);

    expect(
      unregistered.map((entry) => `${entry.gate} (${entry.file})`),
      'add the gate to TEST_GATES in scripts/test-gates.ts and wire it into a CI job',
    ).toEqual([]);
  });

  it('points every registered runner script at the gated-suite runner', () => {
    for (const gate of TEST_GATES) {
      if (!gate.runnerScript) continue;
      const body = packageScripts[gate.runnerScript];
      expect(body, `package.json is missing the "${gate.runnerScript}" script`).toBeDefined();
      expect(body).toContain(GATE_RUNNER_ENTRYPOINT);
      expect(body).toContain(gate.env);
    }
  });

  it('supplies every registered gate from at least one workflow step', () => {
    const unsupplied = TEST_GATES.filter(
      (gate) => stepsSupplyingGate(workflowSteps, gate.env).length === 0,
    ).map((gate) => gate.env);

    expect(
      unsupplied,
      'no workflow job sets these gates, so their suites can never run in CI',
    ).toEqual([]);
  });

  it('runs every gated suite in a job that supplies its gate', () => {
    const unrun: string[] = [];

    for (const suite of gatedSuites) {
      const covered = suite.gates.some((gateEnv) => {
        const gate = findGate(gateEnv);
        if (!gate) return false;

        return stepsSupplyingGate(expandedSteps, gateEnv).some((step) => {
          // A discovery-driven runner reaches new suites without per-file
          // wiring, so invoking it covers everything that reads the gate.
          if (gate.runnerScript && step.expandedRun.includes(GATE_RUNNER_ENTRYPOINT)) return true;
          return step.expandedRun.includes(suite.file);
        });
      });

      if (!covered) unrun.push(`${suite.file} [${suite.gates.join(', ')}]`);
    }

    expect(
      unrun,
      'these suites are gated but no CI job both supplies the gate and runs them — wire them into a job or delete them',
    ).toEqual([]);
  });
});

// The runner turns "a gated suite skipped in its own job" into a failure, so
// the counts it reads off bun's summary are the whole guarantee.
describe('bun test summary parsing', () => {
  const summary = ['', ' 12 pass', ' 3 skip', ' 0 fail', ' 17 expect() calls', ''].join('\n');

  it('reads the pass and skip counts bun actually prints', () => {
    expect(summarizeBunTestOutput(summary)).toEqual({ passed: 12, skipped: 3 });
  });

  it('reports no skips for a clean run', () => {
    expect(summarizeBunTestOutput(' 40 pass\n 0 fail\n')).toEqual({ passed: 40, skipped: 0 });
  });

  it('totals the counts across repeated summaries', () => {
    expect(summarizeBunTestOutput(' 2 pass\n 1 skip\n 5 pass\n 4 skip\n')).toEqual({
      passed: 7,
      skipped: 5,
    });
  });

  it('does not read a count out of unrelated prose', () => {
    expect(summarizeBunTestOutput('would 3 skipper\nchecked 9 passengers\n')).toEqual({
      passed: 0,
      skipped: 0,
    });
  });
});

describe('gated-suite runner invocations are well formed', () => {
  it('only invokes the runner with registered gates', () => {
    const pattern = new RegExp(`${GATE_RUNNER_ENTRYPOINT.replace('.', '\\.')}\\s+(\\S+)`, 'g');
    const invalid: string[] = [];

    for (const step of expandedSteps) {
      for (const match of step.expandedRun.matchAll(pattern)) {
        if (!findGate(match[1])) invalid.push(`${describeStep(step)}: ${match[1]}`);
      }
    }

    expect(invalid).toEqual([]);
  });
});
