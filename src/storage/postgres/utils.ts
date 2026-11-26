// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'crypto';
import type { QueryResult, QueryResultRow } from 'pg';

export type JsonObject = Record<string, unknown>;
export type JsonValue = unknown;

export interface PostgresQueryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export function newId(): string {
  return randomUUID();
}

/** The format `newId()` mints: a random (version 4) UUID. */
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isOpaqueId(value: string): boolean {
  return OPAQUE_ID.test(value);
}

/**
 * Refuse an explicitly supplied row id that is not opaque.
 *
 * A shared observation's id crosses the tenant boundary on a projected row, and
 * that projection is defensible only while the id carries nothing beyond
 * identity: a caller-chosen id such as a slug, a counter or a content hash would
 * turn the same row into a disclosure (ADR 0002 D9, condition 20). The rule is
 * opacity, not absence — an importer preserving server-minted ids passes, which
 * is what keeps id-preserving imports legitimate.
 */
export function assertOpaqueId(field: string, value: string): void {
  if (isOpaqueId(value)) return;
  throw new Error(
    `${field} must be a server-generated random id (UUIDv4); a caller-chosen id is refused`,
  );
}

export function toJsonObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

export function toJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function toEpoch(value: Date | string | number): number {
  if (typeof value === 'number') {
    return value;
  }
  return new Date(value).getTime();
}

export function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

export async function queryOne<T extends QueryResultRow>(
  client: PostgresQueryable,
  text: string,
  values: unknown[] = []
): Promise<T | null> {
  const result = await client.query<T>(text, values);
  return result.rows[0] ?? null;
}

export async function assertProjectOwnership(
  client: PostgresQueryable,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM projects WHERE id = $1 AND team_id = $2',
    [projectId, teamId]
  );
  if (!row) {
    throw new Error('project_id must belong to team_id');
  }
}

export async function assertSessionOwnership(
  client: PostgresQueryable,
  serverSessionId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM server_sessions WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [serverSessionId, projectId, teamId]
  );
  if (!row) {
    throw new Error('server_session_id must belong to project_id and team_id');
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function deterministicKey(parts: readonly unknown[]): string {
  const fingerprint = createHash('sha256')
    .update(canonicalJson(parts))
    .digest('hex');
  return fingerprint;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortJson(record[key]);
        return acc;
      }, {});
  }
  return value;
}
