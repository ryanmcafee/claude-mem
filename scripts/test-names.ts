// SPDX-License-Identifier: Apache-2.0
//
// Test titles as a comparable inventory, so a conflict resolution that takes one
// side of a test file wholesale cannot quietly ship with fewer assertions than
// the branch it merged over (MCAA-395).

import ts from 'typescript';

const TEST_CALLEES = new Set(['it', 'test', 'fit', 'xit']);
const DESCRIBE_CALLEES = new Set(['describe', 'fdescribe', 'xdescribe', 'suite']);
/** Modifiers that return a fresh test function, so the title sits on the outer call. */
const CURRYING_MODIFIERS = new Set(['each', 'if', 'skipIf', 'todoIf', 'failing']);

export interface TestName {
  /** The `it()`/`test()` title, normalized so it is comparable across revisions. */
  readonly title: string;
  /** Enclosing `describe()` titles, outermost first. Diagnostics only. */
  readonly describePath: readonly string[];
  readonly line: number;
}

export interface TestInventory {
  readonly names: readonly TestName[];
  /** Title -> number of declarations, so duplicate titles are not collapsed. */
  readonly counts: ReadonlyMap<string, number>;
}

/** Root identifier of a callee chain: `it.each` -> `it`, `it.skip.each` -> `it`. */
function rootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootName(expression.expression);
  if (ts.isCallExpression(expression)) return rootName(expression.expression);
  return undefined;
}

function trailingProperty(expression: ts.Expression): string | undefined {
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
}

/**
 * A `${}` placeholder keeps an interpolated title stable across revisions, where
 * the substituted expression may be reformatted without changing the test.
 */
function templateTitle(node: ts.TemplateExpression): string {
  return [node.head.text, ...node.templateSpans.map((span) => `\${}${span.literal.text}`)].join('');
}

function titleOf(argument: ts.Expression | undefined): string {
  if (!argument) return '<no title>';
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (ts.isTemplateExpression(argument)) return templateTitle(argument);
  return `<expr: ${argument.getText().replace(/\s+/g, ' ').trim()}>`;
}

type CallKind = 'test' | 'describe' | 'other';

/**
 * `it.each([...])` is a factory whose own call carries the table, not a title —
 * only the call it returns declares a test.
 */
function classify(call: ts.CallExpression): CallKind {
  const callee = call.expression;
  const root = rootName(callee);
  if (!root) return 'other';

  if (!ts.isCallExpression(callee)) {
    const trailing = trailingProperty(callee);
    if (trailing && CURRYING_MODIFIERS.has(trailing)) return 'other';
  }

  if (TEST_CALLEES.has(root)) return 'test';
  if (DESCRIBE_CALLEES.has(root)) return 'describe';
  return 'other';
}

export function collectTestNames(source: string, fileName = 'suite.test.ts'): TestInventory {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const names: TestName[] = [];
  const counts = new Map<string, number>();
  const describePath: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = classify(node);

      if (kind === 'test') {
        const title = titleOf(node.arguments[0]);
        names.push({
          title,
          describePath: [...describePath],
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        });
        counts.set(title, (counts.get(title) ?? 0) + 1);
      }

      if (kind === 'describe') {
        describePath.push(titleOf(node.arguments[0]));
        ts.forEachChild(node, visit);
        describePath.pop();
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(parsed, visit);
  return { names, counts };
}

export interface RemovedTest {
  readonly title: string;
  readonly baseCount: number;
  readonly headCount: number;
  /** Where the title lived on the base side, for the failure message. */
  readonly describePath: readonly string[];
}

/**
 * Titles that lost a declaration. Compares counts rather than set membership so
 * one of two same-titled tests disappearing is still caught, and compares names
 * rather than a total so a rename plus a deletion cannot net to zero.
 */
export function diffTestNames(base: TestInventory, head: TestInventory): RemovedTest[] {
  const removed: RemovedTest[] = [];

  for (const [title, baseCount] of base.counts) {
    const headCount = head.counts.get(title) ?? 0;
    if (headCount >= baseCount) continue;
    removed.push({
      title,
      baseCount,
      headCount,
      describePath: base.names.find((name) => name.title === title)?.describePath ?? [],
    });
  }

  return removed.sort((a, b) => a.title.localeCompare(b.title));
}

const REMOVED_TEST_TRAILER = /^[ \t]*Removed-test:[ \t]*(["'`])([\s\S]*?)\1[ \t]*(.*)$/gm;

export interface RemovalWaiver {
  readonly title: string;
  readonly reason: string;
}

/**
 * `Removed-test: "<exact title>" <why>` lines from the commit bodies in a range.
 * The quotes bound the title so a title containing a separator still parses, and
 * the reason is required: naming a deletion without saying why is not a waiver.
 */
export function parseRemovalWaivers(commitBodies: string): RemovalWaiver[] {
  const waivers: RemovalWaiver[] = [];

  for (const match of commitBodies.matchAll(REMOVED_TEST_TRAILER)) {
    const reason = match[3].replace(/^[\s\-:|—–]+/, '').trim();
    if (reason.length === 0) continue;
    waivers.push({ title: match[2], reason });
  }

  return waivers;
}

export function isWaived(title: string, waivers: readonly RemovalWaiver[]): boolean {
  return waivers.some((waiver) => waiver.title === title);
}

export const TESTS_REMOVED_LABEL = 'tests-removed';

/** Accepts the JSON array Actions renders from `labels.*.name`, or a plain list. */
export function parseLabels(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim());
      }
    } catch {
      // Fall through to the delimited form rather than hiding a malformed value.
    }
  }

  return trimmed
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
