// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from 'fs';
import path from 'path';

export interface TestGate {
  /** Environment variable a suite reads to decide whether it can run. */
  readonly env: string;
  /**
   * package.json script that runs every suite discovered for this gate. A gate
   * with a runner needs no per-file wiring: new suites are picked up by
   * discovery. A gate without one must name each suite in a workflow step.
   */
  readonly runnerScript?: string;
}

export const GATE_RUNNER_ENTRYPOINT = 'scripts/run-gated-suite.ts';

export const TEST_GATES: readonly TestGate[] = [
  { env: 'CLAUDE_MEM_TEST_POSTGRES_URL', runnerScript: 'test:postgres' },
  { env: 'CLAUDE_MEM_TEST_CHROMA' },
  { env: 'CLAUDE_MEM_TEST_CHROMA_POLLUTED_ENV' },
];

const GATE_ENV_PATTERN = /process\.env\.(CLAUDE_MEM_TEST_[A-Z0-9_]+)/g;

export function findGate(env: string): TestGate | undefined {
  return TEST_GATES.find((gate) => gate.env === env);
}

/**
 * Gates a suite reads, from its source alone, so a file can be classified at a
 * git revision that is not checked out.
 */
export function gatesInSource(source: string): string[] {
  const gates = new Set<string>();
  for (const match of source.matchAll(GATE_ENV_PATTERN)) {
    gates.add(match[1]);
  }
  return [...gates].sort();
}

function walk(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, acc);
    } else if (entry.name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

export interface GatedSuite {
  /** Repo-relative, forward-slash path usable directly as a `bun test` argument. */
  readonly file: string;
  readonly gates: readonly string[];
}

/**
 * Every suite under `tests/` that reads a `CLAUDE_MEM_TEST_*` gate, keyed by
 * repo-relative path. Over-inclusion is safe: an extra file gets run, while a
 * missed one is the silent-skip defect this discovery exists to prevent.
 */
export function discoverGatedSuites(repoRoot: string): GatedSuite[] {
  const testsRoot = path.join(repoRoot, 'tests');
  const suites: GatedSuite[] = [];

  for (const absolute of walk(testsRoot, []).sort()) {
    const gates = gatesInSource(readFileSync(absolute, 'utf8'));
    if (gates.length === 0) continue;
    suites.push({
      file: path.relative(repoRoot, absolute).split(path.sep).join('/'),
      gates,
    });
  }

  return suites;
}

export function suitesForGate(repoRoot: string, env: string): string[] {
  return discoverGatedSuites(repoRoot)
    .filter((suite) => suite.gates.includes(env))
    .map((suite) => suite.file);
}

export interface WorkflowStep {
  readonly workflow: string;
  readonly job: string;
  readonly name: string;
  readonly run: string;
  /** Job-level env merged with step-level env, step winning. */
  readonly env: Readonly<Record<string, string>>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function envStrings(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      result[key] = String(raw);
    }
  }
  return result;
}

export function loadWorkflowSteps(repoRoot: string): WorkflowStep[] {
  const workflowDir = path.join(repoRoot, '.github', 'workflows');
  const steps: WorkflowStep[] = [];

  for (const entry of readdirSync(workflowDir).sort()) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
    const parsed = asRecord(Bun.YAML.parse(readFileSync(path.join(workflowDir, entry), 'utf8')));
    const workflowEnv = envStrings(parsed.env);

    for (const [job, rawJob] of Object.entries(asRecord(parsed.jobs))) {
      const jobRecord = asRecord(rawJob);
      const jobEnv = { ...workflowEnv, ...envStrings(jobRecord.env) };
      const rawSteps = Array.isArray(jobRecord.steps) ? jobRecord.steps : [];

      for (const rawStep of rawSteps) {
        const step = asRecord(rawStep);
        if (typeof step.run !== 'string') continue;
        steps.push({
          workflow: entry,
          job,
          name: typeof step.name === 'string' ? step.name : '(unnamed)',
          run: step.run,
          env: { ...jobEnv, ...envStrings(step.env) },
        });
      }
    }
  }

  return steps;
}

/**
 * Inlines `npm run <script>` / `bun run <script>` so a gate wired through a
 * package.json script is recognised the same as a direct invocation.
 */
export function expandPackageScripts(
  command: string,
  scripts: Readonly<Record<string, string>>,
  depth = 3,
): string {
  if (depth <= 0) return command;
  return command.replace(
    /(?:npm|bun|pnpm|yarn)\s+run\s+([\w:-]+)/g,
    (whole, name: string) =>
      name in scripts ? `${whole} ${expandPackageScripts(scripts[name], scripts, depth - 1)}` : whole,
  );
}

export function loadPackageScripts(repoRoot: string): Record<string, string> {
  const pkg = asRecord(JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')));
  const scripts: Record<string, string> = {};
  for (const [name, body] of Object.entries(asRecord(pkg.scripts))) {
    if (typeof body === 'string') scripts[name] = body;
  }
  return scripts;
}

export interface BunTestSummary {
  readonly passed: number;
  readonly skipped: number;
}

/**
 * Reads the counts off `bun test`'s trailing summary (` 12 pass` / ` 3 skip`).
 * Totals across files because a multi-file run prints one summary per invocation
 * but reruns print their own.
 */
export function summarizeBunTestOutput(output: string): BunTestSummary {
  const total = (label: string): number =>
    [...output.matchAll(new RegExp(String.raw`^\s*(\d+)\s+${label}\b`, 'gm'))].reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    );

  return { passed: total('pass'), skipped: total('skip') };
}

/** Steps that actually put a usable value for `env` into the process environment. */
export function stepsSupplyingGate<T extends Pick<WorkflowStep, 'env'>>(
  steps: readonly T[],
  env: string,
): T[] {
  return steps.filter((step) => {
    const value = step.env[env];
    return typeof value === 'string' && value.length > 0;
  });
}
