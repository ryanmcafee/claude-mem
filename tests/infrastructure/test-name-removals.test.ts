// SPDX-License-Identifier: Apache-2.0
//
// A conflict resolution that takes one side of a test file wholesale keeps the
// file, keeps the suite green, and silently ships fewer assertions (MCAA-395).
// The fixtures here are the real #8/#11 resolution that produced the failure.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import {
  TESTS_REMOVED_LABEL,
  collectTestNames,
  diffTestNames,
  isWaived,
  parseLabels,
  parseRemovalWaivers,
} from '../../scripts/test-names.js';
import {
  expandPackageScripts,
  gatesInSource,
  loadPackageScripts,
  loadWorkflowSteps,
} from '../../scripts/test-gates.js';

const repoRoot = path.resolve(__dirname, '../..');
const CHECK_ENTRYPOINT = 'scripts/check-test-name-removals.ts';

function fixture(name: string): string {
  return readFileSync(path.join(repoRoot, 'tests/fixtures/test-name-removals', name), 'utf8');
}

function removedTitles(baseSource: string, headSource: string): string[] {
  return diffTestNames(collectTestNames(baseSource), collectTestNames(headSource)).map((r) => r.title);
}

// The two titles the real resolution dropped: MCAA-281's own acceptance criterion.
const MCAA_281_TITLES = [
  'keeps a per-event generated observation private despite shared-looking input',
  'keeps a session-summary generated observation private despite shared-looking input',
];

describe('MCAA-352 regression: the real #8/#11 resolution', () => {
  const base = fixture('mcaa-352-base.ts.txt');
  const resolution = fixture('mcaa-352-resolution.ts.txt');

  it('reports exactly the two tests the resolution dropped', () => {
    expect(removedTitles(base, resolution).sort()).toEqual([...MCAA_281_TITLES].sort());
  });

  it('attributes them to the describe block that vanished', () => {
    const removed = diffTestNames(collectTestNames(base), collectTestNames(resolution));
    for (const removal of removed) {
      expect(removal.describePath.at(-1)).toBe('MCAA-281 — generated observations stay private');
      expect(removal.headCount).toBe(0);
    }
  });

  it('is scoped in by the Postgres gate both sides read', () => {
    expect(gatesInSource(base)).toContain('CLAUDE_MEM_TEST_POSTGRES_URL');
    expect(gatesInSource(resolution)).toContain('CLAUDE_MEM_TEST_POSTGRES_URL');
  });

  it('stays silent in the safe direction, where the resolution kept both tests', () => {
    expect(removedTitles(resolution, base)).toEqual([]);
  });
});

describe('test title extraction', () => {
  it('counts a conditionally-skipped test a grep for `it(` at line start misses', () => {
    const inventory = collectTestNames(`
      describe('suite', () => {
        if (!url) {
          it.skip('requires a database', () => {});
          return;
        }
        it('works', () => {});
      });
    `);

    expect(inventory.names.map((n) => n.title)).toEqual(['requires a database', 'works']);
  });

  it('reads the title off the outer call of a curried `it.each`', () => {
    const inventory = collectTestNames(`
      it.each([1, 2])('handles %s', () => {});
      describe.each(['a'])('group %s', () => {
        test.only('inner', () => {});
      });
    `);

    expect(inventory.names.map((n) => n.title)).toEqual(['handles %s', 'inner']);
    expect(inventory.names[1]!.describePath).toEqual(['group %s']);
  });

  it('normalizes an interpolated title so reformatting the expression is not a removal', () => {
    const before = collectTestNames('it(`case ${kind} ok`, () => {});');
    const after = collectTestNames('it(`case ${ kind } ok`, () => {});');

    expect(diffTestNames(before, after)).toEqual([]);
    expect(before.names[0]!.title).toBe('case ${} ok');
  });

  it('does not treat a helper named like a test callee as a declaration', () => {
    const inventory = collectTestNames(`
      const suites = [1].map(n => n);
      pattern.test('not a test');
      it('real', () => {});
    `);

    expect(inventory.names.map((n) => n.title)).toEqual(['real']);
  });
});

describe('removal detection', () => {
  it('catches a deletion hidden behind a rename, which nets to zero on a count', () => {
    const base = collectTestNames("it('kept', () => {}); it('deleted', () => {});");
    const head = collectTestNames("it('kept renamed', () => {}); it('added', () => {});");

    // Same total either way, so a count-based check would see nothing here.
    expect(base.names.length).toBe(head.names.length);
    expect(diffTestNames(base, head).map((r) => r.title)).toEqual(['deleted', 'kept']);
  });

  // The cost of catching the line above: a title is the only identity a test has,
  // so a rename is indistinguishable from a deletion and must be declared too.
  it('reports a pure rename, because a title is the only identity a test has', () => {
    const base = collectTestNames("it('old title', () => {});");
    const head = collectTestNames("it('new title', () => {});");

    expect(diffTestNames(base, head).map((r) => r.title)).toEqual(['old title']);
  });

  it('catches one of two same-titled tests disappearing', () => {
    const base = collectTestNames(`
      describe('a', () => { it('works', () => {}); });
      describe('b', () => { it('works', () => {}); });
    `);
    const head = collectTestNames("describe('a', () => { it('works', () => {}); });");

    const removed = diffTestNames(base, head);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ title: 'works', baseCount: 2, headCount: 1 });
  });

  it('reports every test when a suite is deleted outright', () => {
    const base = collectTestNames("it('a', () => {}); it('b', () => {});");

    expect(diffTestNames(base, collectTestNames('')).map((r) => r.title)).toEqual(['a', 'b']);
  });

  it('passes an addition-only change', () => {
    const base = collectTestNames("it('a', () => {});");
    const head = collectTestNames("it('a', () => {}); it('b', () => {});");

    expect(diffTestNames(base, head)).toEqual([]);
  });

  it('passes a change that only edits a test body', () => {
    const base = collectTestNames("it('a', () => { expect(1).toBe(1); });");
    const head = collectTestNames("it('a', () => { expect(2).toBe(2); expect(3).toBe(3); });");

    expect(diffTestNames(base, head)).toEqual([]);
  });
});

describe('escape hatches for a legitimate deletion', () => {
  it('accepts a trailer that names the title and a reason', () => {
    const waivers = parseRemovalWaivers(
      'test: fold the legacy path\n\nRemoved-test: "covers the legacy path" replaced by the parameterised case\n',
    );

    expect(waivers).toEqual([
      { title: 'covers the legacy path', reason: 'replaced by the parameterised case' },
    ]);
    expect(isWaived('covers the legacy path', waivers)).toBe(true);
    expect(isWaived('something else', waivers)).toBe(false);
  });

  it('rejects a trailer that names a title but no reason', () => {
    expect(parseRemovalWaivers('Removed-test: "covers the legacy path"')).toEqual([]);
    expect(parseRemovalWaivers('Removed-test: "covers the legacy path" --')).toEqual([]);
  });

  it('parses a title containing the separators a reason might use', () => {
    const waivers = parseRemovalWaivers('Removed-test: "a -- b | c" merged into the table-driven case');

    expect(waivers).toEqual([{ title: 'a -- b | c', reason: 'merged into the table-driven case' }]);
  });

  it('does not let one title waive a different title that it prefixes', () => {
    const waivers = parseRemovalWaivers('Removed-test: "handles a case fully" superseded');

    expect(isWaived('handles a case', waivers)).toBe(false);
    expect(isWaived('handles a case fully', waivers)).toBe(true);
  });

  it('reads the label list Actions renders from labels.*.name', () => {
    expect(parseLabels(`["bug","${TESTS_REMOVED_LABEL}"]`)).toContain(TESTS_REMOVED_LABEL);
    expect(parseLabels(`bug, ${TESTS_REMOVED_LABEL}`)).toContain(TESTS_REMOVED_LABEL);
    expect(parseLabels('[]')).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
  });
});

// The check is only a control if CI runs it and a failure blocks the build.
describe('the check is wired into PR CI', () => {
  const packageScripts = loadPackageScripts(repoRoot);
  const steps = loadWorkflowSteps(repoRoot).map((step) => ({
    ...step,
    expandedRun: expandPackageScripts(step.run, packageScripts),
  }));

  it('is invoked by a step in a CI workflow', () => {
    const invoking = steps.filter((step) => step.expandedRun.includes(CHECK_ENTRYPOINT));

    expect(
      invoking.map((step) => `${step.workflow} / ${step.job}`),
      `no workflow step runs ${CHECK_ENTRYPOINT}, so a dropped test would still merge green`,
    ).not.toEqual([]);
    expect(invoking.some((step) => step.workflow === 'ci.yml')).toBe(true);
  });

  it('is reachable through a package script', () => {
    const script = Object.entries(packageScripts).find(([, body]) => body.includes(CHECK_ENTRYPOINT));

    expect(script, `add a package.json script that runs ${CHECK_ENTRYPOINT}`).toBeDefined();
  });
});
