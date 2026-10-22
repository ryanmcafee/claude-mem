// SPDX-License-Identifier: Apache-2.0

import { AttributionTrailersSchema, type AttributionTrailers } from './agent-identity.js';

export const TRAILER_KEYS = {
  agent: 'Paperclip-Agent',
  agentId: 'Paperclip-Agent-Id',
  run: 'Paperclip-Run'
} as const satisfies Record<keyof AttributionTrailers, string>;

type TrailerField = keyof typeof TRAILER_KEYS;
type TrailerKey = (typeof TRAILER_KEYS)[TrailerField];

const FIELDS = ['agent', 'agentId', 'run'] as const satisfies readonly TrailerField[];
const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/;
const CONTINUATION_LINE = /^[ \t]+\S/;

export type TrailerParse =
  | { status: 'absent' }
  | { status: 'label'; label: AttributionTrailers }
  | { status: 'incomplete'; missing: TrailerKey[] }
  | { status: 'conflicting'; keys: TrailerKey[] }
  | { status: 'invalid'; keys: TrailerKey[] };

function paragraphs(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) => block.split('\n'))
    .filter((lines) => lines.some((line) => line.trim() !== ''));
}

function trailerLines(paragraph: string[]): Array<[string, string]> | null {
  const entries: Array<[string, string]> = [];
  for (const line of paragraph) {
    if (CONTINUATION_LINE.test(line)) continue;
    const match = TRAILER_LINE.exec(line);
    if (!match) return null;
    entries.push([match[1], match[2].trim()]);
  }
  return entries;
}

function finalTrailerBlock(text: string): Array<[string, string]> {
  const last = paragraphs(text).at(-1);
  return (last && trailerLines(last)) ?? [];
}

export function parseAttributionTrailers(text: string): TrailerParse {
  const valuesByField = new Map<TrailerField, Set<string>>();
  for (const [key, value] of finalTrailerBlock(text)) {
    const field = FIELDS.find((candidate) => TRAILER_KEYS[candidate].toLowerCase() === key.toLowerCase());
    if (field) valuesByField.set(field, (valuesByField.get(field) ?? new Set()).add(value));
  }

  if (valuesByField.size === 0) return { status: 'absent' };

  const conflicting = FIELDS.filter((field) => (valuesByField.get(field)?.size ?? 0) > 1);
  if (conflicting.length > 0) return { status: 'conflicting', keys: conflicting.map((f) => TRAILER_KEYS[f]) };

  const missing = FIELDS.filter((field) => !valuesByField.has(field));
  if (missing.length > 0) return { status: 'incomplete', missing: missing.map((f) => TRAILER_KEYS[f]) };

  const candidate = Object.fromEntries(FIELDS.map((field) => [field, [...(valuesByField.get(field) ?? [])][0]]));
  const parsed = AttributionTrailersSchema.safeParse(candidate);
  if (!parsed.success) {
    const invalid = new Set(parsed.error.issues.map((issue) => issue.path[0]));
    return { status: 'invalid', keys: FIELDS.filter((f) => invalid.has(f)).map((f) => TRAILER_KEYS[f]) };
  }
  return { status: 'label', label: parsed.data };
}

export function formatAttributionTrailers(trailers: AttributionTrailers): string {
  const valid = AttributionTrailersSchema.parse(trailers);
  return FIELDS.map((field) => `${TRAILER_KEYS[field]}: ${valid[field]}`).join('\n');
}

export function appendAttributionTrailers(text: string, trailers: AttributionTrailers): string {
  const block = formatAttributionTrailers(trailers);
  const existing = parseAttributionTrailers(text);
  if (existing.status === 'label' && formatAttributionTrailers(existing.label) === block) return text;
  if (existing.status !== 'absent') {
    throw new Error(`Refusing to append attribution trailers: the text already carries ${existing.status} Paperclip trailers`);
  }

  const body = text.replace(/\s+$/, '');
  if (body === '') return block;
  const blocks = paragraphs(body);
  const extendsTrailerBlock = blocks.length > 1 && trailerLines(blocks[blocks.length - 1]) !== null;
  return `${body}${extendsTrailerBlock ? '\n' : '\n\n'}${block}`;
}
