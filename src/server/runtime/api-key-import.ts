// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { PostgresAuthRepository } from '../../storage/postgres/auth.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { findOrCreateProject, findOrCreateTeam } from '../../services/hooks/server-bootstrap.js';

export const IMPORTED_API_KEY_SCOPES: readonly string[] = Object.freeze(['memories:read', 'memories:write']);
export const MIN_IMPORTED_API_KEY_LENGTH = 32;
const IMPORT_ACTOR_ID = 'system:server-api-key-import';

export interface ImportedApiKeyResult {
  id: string;
  name: string;
  status: 'imported' | 'exists' | 'revoked';
  scopes: string[];
}

export function normalizeImportedApiKey(raw: string, name: string): string {
  const key = raw.trim();
  if (key.length < MIN_IMPORTED_API_KEY_LENGTH) {
    throw new Error(
      `API key "${name}" is ${key.length} characters; imported keys need at least ${MIN_IMPORTED_API_KEY_LENGTH}. Generate one with \`openssl rand -hex 32\`.`,
    );
  }
  if (/\s/.test(key)) {
    throw new Error(`API key "${name}" contains whitespace; store exactly one key per Secret entry.`);
  }
  return key;
}

export async function importServerApiKey(
  pool: PostgresPool,
  input: { name: string; rawKey: string },
): Promise<ImportedApiKeyResult> {
  const keyHash = createHash('sha256').update(normalizeImportedApiKey(input.rawKey, input.name)).digest('hex');
  const scopes = [...IMPORTED_API_KEY_SCOPES];
  const existing = await findKeyByHash(pool, keyHash);
  if (existing) {
    return { id: existing.id, name: input.name, status: existing.revoked ? 'revoked' : 'exists', scopes: existing.scopes };
  }

  const teamId = await findOrCreateTeam(pool);
  const projectId = await findOrCreateProject(pool, teamId);
  const repo = new PostgresAuthRepository(pool);
  try {
    const created = await repo.createApiKey({ keyHash, teamId, projectId, actorId: IMPORT_ACTOR_ID, scopes });
    await repo.createAuditLog({
      teamId,
      projectId,
      actorId: IMPORT_ACTOR_ID,
      apiKeyId: created.id,
      action: 'api_key.create',
      resourceType: 'api_key',
      resourceId: created.id,
      details: { source: 'server-api-key-import', name: input.name },
    });
    return { id: created.id, name: input.name, status: 'imported', scopes };
  } catch (error) {
    const raced = isUniqueViolation(error) ? await findKeyByHash(pool, keyHash) : null;
    if (raced) {
      return { id: raced.id, name: input.name, status: raced.revoked ? 'revoked' : 'exists', scopes: raced.scopes };
    }
    throw error;
  }
}

async function findKeyByHash(
  pool: PostgresPool,
  keyHash: string,
): Promise<{ id: string; revoked: boolean; scopes: string[] } | null> {
  const result = await pool.query<{ id: string; revoked_at: Date | null; scopes: unknown }>(
    'SELECT id, revoked_at, scopes FROM api_keys WHERE key_hash = $1',
    [keyHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [];
  return { id: row.id, revoked: row.revoked_at !== null, scopes };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
