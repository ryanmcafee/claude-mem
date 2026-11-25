// SPDX-License-Identifier: Apache-2.0

import type { PostgresPool } from '../../storage/postgres/pool.js';

export interface ListServerApiKeysOptions {
  team?: string;
  active?: boolean;
  limit?: string;
  offset?: string;
}

export interface ListedServerApiKey {
  id: string;
  teamId: string | null;
  projectId: string | null;
  scopes: unknown;
  status: 'active' | 'revoked';
  expiresAt: string | null;
  createdAt: string;
}

export interface ServerApiKeyList {
  teamId: string | null;
  limit: number;
  offset: number;
  count: number;
  keys: ListedServerApiKey[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function listServerApiKeys(
  pool: PostgresPool,
  options: ListServerApiKeysOptions,
): Promise<ServerApiKeyList> {
  const teamFilter = options.team ?? null;
  const limitArg = Number.parseInt(options.limit ?? String(DEFAULT_LIMIT), 10);
  const offsetArg = Number.parseInt(options.offset ?? '0', 10);
  const limit = Number.isFinite(limitArg) && limitArg > 0 && limitArg <= MAX_LIMIT ? limitArg : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetArg) && offsetArg >= 0 ? offsetArg : 0;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.active) {
    conditions.push('revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())');
  }
  if (teamFilter) {
    params.push(teamFilter);
    conditions.push(`team_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  // SECURITY: SELECT only non-secret metadata, never key_hash.
  const result = await pool.query<{
    id: string;
    team_id: string | null;
    project_id: string | null;
    scopes: unknown;
    revoked_at: Date | null;
    expires_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, team_id, project_id, scopes, revoked_at, expires_at, created_at
     FROM api_keys
     ${where}
     ORDER BY created_at DESC, id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    teamId: teamFilter,
    limit,
    offset,
    count: result.rows.length,
    keys: result.rows.map(row => ({
      id: row.id,
      teamId: row.team_id,
      projectId: row.project_id,
      scopes: row.scopes,
      status: row.revoked_at ? 'revoked' : 'active',
      expiresAt: row.expires_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    })),
  };
}
