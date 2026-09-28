// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../utils/logger.js';
import type { PostgresQueryable } from './utils.js';

export const SERVER_POSTGRES_SCHEMA_VERSION = 1;

// Phase 1b (cmem-sdk rename): the TS constant is renamed but the table-name
// strings remain on `server_beta_*` since they are persisted DDL identifiers.
// Plan §1d will migrate the table names in a coordinated DDL change.
export const SERVER_POSTGRES_TABLES = [
  'server_beta_schema_migrations',
  'teams',
  'projects',
  'team_members',
  'api_keys',
  'audit_log',
  'server_sessions',
  'agent_events',
  'observation_generation_jobs',
  'observations',
  'observation_sources',
  'observation_generation_job_events',
  'usage_events',
  'rate_limit_counters',
  'corpora',
  'corpus_members',
  'corpus_artifacts'
] as const;

/**
 * Down path for the MCAA-237 shared-scope column. Kept next to the forward DDL
 * so the rollback is exercised by tests rather than reconstructed by hand
 * during an incident. Re-running the bootstrap after this re-adds the column
 * with its `false` default; no row data outside the column itself is touched.
 */
export const SHARED_SCOPE_DOWN_SQL = `
DROP INDEX IF EXISTS idx_observations_shared;
ALTER TABLE observations DROP COLUMN IF EXISTS shared;
`;

/**
 * Down path for the MCAA-260 remote corpus tables (ADR 0001 D1). Additive
 * forward DDL, so the rollback drops only what the corpus feature added and
 * never touches `observations` rows. Corpora are derived state — membership is
 * stored by reference and artifacts are a cache — so dropping them loses no
 * captured memory; an operator re-runs `build_corpus` after rolling forward.
 */
export const CORPUS_DOWN_SQL = `
DROP TABLE IF EXISTS corpus_artifacts;
DROP TABLE IF EXISTS corpus_members;
DROP TABLE IF EXISTS corpora;
DROP INDEX IF EXISTS idx_observations_metadata;
`;

/**
 * ADR 0002 condition 23. The build gate that refuses a shared-scope filter on
 * `metadataMatch`/`platformSource` is prospective, but a corpus materialized
 * before it keeps those foreign members at rest and keeps answering the same
 * question through `observationCount`. Membership, the cached renders derived
 * from it and the stored counts are all cleared; the corpus row survives so the
 * operator still sees it and gets the explaining 400 on rebuild.
 *
 * The predicate mirrors `ownerOnlyFilterFields()`: an absent `metadataMatch`,
 * `{}`, a null `platformSource` and `''` all emit no clause and so select
 * nothing. Safe to re-run — after the gate ships the affected set is empty,
 * which is why it sits in the ordinary bootstrap rather than a one-shot script.
 * Condition 11's artifact purge folds in here when it lands.
 */
export const CORPUS_PREGATE_PURGE_SQL = `
WITH poisoned AS (
  SELECT id FROM corpora
  WHERE member_scope = 'shared'
    AND (
      (jsonb_typeof(filter -> 'metadataMatch') = 'object' AND filter -> 'metadataMatch' <> '{}'::jsonb)
      OR COALESCE(filter ->> 'platformSource', '') <> ''
    )
),
purged_members AS (
  DELETE FROM corpus_members WHERE corpus_id IN (SELECT id FROM poisoned)
),
purged_artifacts AS (
  DELETE FROM corpus_artifacts WHERE corpus_id IN (SELECT id FROM poisoned)
)
UPDATE corpora SET stats = '{}'::jsonb, built_at = NULL, updated_at = now()
WHERE id IN (SELECT id FROM poisoned);
`;

export async function bootstrapServerPostgresSchema(client: PostgresQueryable): Promise<void> {
  if (isPostgresPool(client)) {
    const poolClient = await client.connect();
    try {
      await bootstrapServerPostgresSchema(poolClient);
    } finally {
      poolClient.release();
    }
    return;
  }

  await client.query('BEGIN');
  try {
    await applyPhase1Migration(client);
    await client.query('COMMIT');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('SYSTEM', 'postgres schema bootstrap failed, rolling back', {}, err);
    await client.query('ROLLBACK');
    throw error;
  }
}

async function applyPhase1Migration(client: PostgresQueryable): Promise<void> {
  await client.query(PHASE_1_SCHEMA_SQL);
  await client.query(CORPUS_PREGATE_PURGE_SQL);
  await client.query(
    `
      INSERT INTO server_beta_schema_migrations (version, description)
      VALUES ($1, $2)
      ON CONFLICT (version) DO NOTHING
    `,
    [SERVER_POSTGRES_SCHEMA_VERSION, 'phase 1 postgres observation storage foundation']
  );
}

interface PostgresPoolLike extends PostgresQueryable {
  connect(): Promise<PostgresQueryable & { release(): void }>;
}

function isPostgresPool(client: PostgresQueryable): client is PostgresPoolLike {
  const candidate = client as {
    connect?: unknown;
    release?: unknown;
    totalCount?: unknown;
    idleCount?: unknown;
    waitingCount?: unknown;
  };
  return (
    typeof candidate.connect === 'function'
    && typeof candidate.release !== 'function'
    && typeof candidate.totalCount === 'number'
    && typeof candidate.idleCount === 'number'
    && typeof candidate.waitingCount === 'number'
  );
}

const PHASE_1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS server_beta_schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, team_id)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (project_id IS NULL OR team_id IS NOT NULL),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  actor_id TEXT,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (project_id IS NULL OR team_id IS NOT NULL),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS server_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  external_session_id TEXT,
  idempotency_key TEXT,
  content_session_id TEXT,
  agent_id TEXT,
  agent_type TEXT,
  platform_source TEXT,
  generation_status TEXT NOT NULL DEFAULT 'idle',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  last_generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  source_adapter TEXT NOT NULL,
  source_event_id TEXT,
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),
  UNIQUE (id, project_id, team_id),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS observation_generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_event_id TEXT REFERENCES agent_events(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent_event', 'session_summary', 'observation_reindex')),
  source_id TEXT NOT NULL,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  bullmq_job_id TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  last_error JSONB,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (source_type = 'agent_event' AND agent_event_id IS NOT NULL AND source_id = agent_event_id)
    OR
    (source_type = 'session_summary' AND agent_event_id IS NULL AND server_session_id IS NOT NULL AND source_id = server_session_id)
    OR
    (source_type = 'observation_reindex' AND agent_event_id IS NULL)
  ),
  FOREIGN KEY (agent_event_id, project_id, team_id) REFERENCES agent_events(id, project_id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_session_id TEXT REFERENCES server_sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'observation',
  content TEXT NOT NULL,
  content_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  generation_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding JSONB,
  created_by_job_id TEXT REFERENCES observation_generation_jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS observation_sources (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  agent_event_id TEXT REFERENCES agent_events(id) ON DELETE CASCADE,
  generation_job_id TEXT REFERENCES observation_generation_jobs(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent_event', 'session_summary', 'observation_reindex', 'manual')),
  source_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (observation_id, source_type, source_id),
  UNIQUE (source_type, source_id, generation_job_id, observation_id),
  CHECK (
    (source_type = 'agent_event' AND agent_event_id IS NOT NULL AND source_id = agent_event_id)
    OR
    (source_type <> 'agent_event' AND agent_event_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS observation_generation_job_events (
  id TEXT PRIMARY KEY,
  generation_job_id TEXT NOT NULL REFERENCES observation_generation_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('queued', 'enqueued', 'processing', 'retry_scheduled', 'completed', 'failed', 'cancelled')),
  status_after TEXT NOT NULL CHECK (status_after IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_project_session ON agent_events(project_id, server_session_id, occurred_at);
ALTER TABLE server_sessions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE server_sessions DROP CONSTRAINT IF EXISTS server_sessions_project_id_external_session_id_key;
-- #2560 — platform_source on agent_events (consistent with server_sessions and
-- the plan-09 scoping): which platform produced the event (claude-code,
-- opencode, cursor, ...). Idempotent so an existing DB upgrades in place.
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS platform_source TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_events_platform_source
  ON agent_events(team_id, project_id, platform_source, occurred_at)
  WHERE platform_source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_server_sessions_platform_source
  ON server_sessions(team_id, project_id, platform_source, started_at)
  WHERE platform_source IS NOT NULL;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS content_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
-- MCAA-237 — shared (cross-tenant) knowledge. An observation stays private to
-- its own team unless it is published with shared = true, and a read only sees
-- shared rows when the query opts in. Additive with a false default, so every
-- existing row and every existing query keeps its current meaning.
-- Down: see SHARED_SCOPE_DOWN_SQL below.
ALTER TABLE observations ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_observations_shared
  ON observations(shared, updated_at DESC)
  WHERE shared;
ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_generation_key_key;
ALTER TABLE observation_generation_jobs DROP CONSTRAINT IF EXISTS observation_generation_jobs_source_type_source_id_job_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sessions_project_idempotency
  ON server_sessions(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sessions_external_session_legacy
  ON server_sessions(project_id, external_session_id)
  WHERE external_session_id IS NOT NULL AND platform_source IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sessions_external_session_platform
  ON server_sessions(project_id, platform_source, external_session_id)
  WHERE external_session_id IS NOT NULL AND platform_source IS NOT NULL;
DROP INDEX IF EXISTS idx_server_sessions_content_session;
-- Supports platform-aware session linkage lookup on the /v1/events ingest path.
CREATE INDEX IF NOT EXISTS idx_server_sessions_content_session_platform
  ON server_sessions(team_id, project_id, platform_source, content_session_id, started_at DESC)
  WHERE content_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_generation_key_scope
  ON observations(team_id, project_id, generation_key)
  WHERE generation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_jobs_source_scope
  ON observation_generation_jobs(team_id, project_id, source_type, source_id, job_type);
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_events_team_project ON agent_events(team_id, project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_observations_project_session ON observations(project_id, server_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_team_project ON observations(team_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_content_search ON observations USING GIN (content_search);
CREATE INDEX IF NOT EXISTS idx_observation_sources_event ON observation_sources(agent_event_id);
CREATE INDEX IF NOT EXISTS idx_observation_sources_source ON observation_sources(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_status_next_attempt ON observation_generation_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_team_project ON observation_generation_jobs(team_id, project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_event ON observation_generation_jobs(agent_event_id);
CREATE INDEX IF NOT EXISTS idx_observation_jobs_source ON observation_generation_jobs(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_observation_job_events_job_created ON observation_generation_job_events(generation_job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_scope_created ON audit_log(project_id, team_id, created_at);

-- Usage metering: append-only per-team usage, aggregated for quotas + billing.
-- kind is open-ended ('request', 'tokens_in', 'tokens_out', 'observation', ...).
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  quantity BIGINT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_events_team_created ON usage_events(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_team_kind_created ON usage_events(team_id, kind, created_at);

-- Fixed-window rate-limit counters. subject_id is the api key id (per-key limit).
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  subject_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_id, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window ON rate_limit_counters(window_start);

-- MCAA-260 — remote knowledge corpora (ADR 0001 D1). A corpus is owned by
-- (team_id, project_id) like observations, and corpus_members carries the
-- composite FK back so a membership edge physically cannot cross tenants.
-- Membership is by reference only: no observation content lives in corpora or
-- corpus_members. Down: see CORPUS_DOWN_SQL above.
CREATE TABLE IF NOT EXISTS corpora (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  filter_digest TEXT NOT NULL,
  member_scope TEXT NOT NULL DEFAULT 'project'
    CHECK (member_scope IN ('project', 'shared')),
  shared BOOLEAN NOT NULL DEFAULT false,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  built_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, project_id, name),
  UNIQUE (id, project_id, team_id),
  FOREIGN KEY (project_id, team_id) REFERENCES projects(id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS corpus_members (
  corpus_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  PRIMARY KEY (corpus_id, observation_id),
  FOREIGN KEY (corpus_id, project_id, team_id)
    REFERENCES corpora(id, project_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS corpus_artifacts (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
  content_digest TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  rendered TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  primed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (corpus_id, content_digest)
);

CREATE INDEX IF NOT EXISTS idx_corpora_shared
  ON corpora(shared, updated_at DESC) WHERE shared;

-- Postgres does not index a referencing FK column automatically, so without this
-- the observations -> corpus_members cascade sequential-scans corpus_members on
-- every DELETE /v1/memories/:id, and once per row for DELETE .../memory.
CREATE INDEX IF NOT EXISTS idx_corpus_members_observation
  ON corpus_members(observation_id);

-- metadataMatch is the documented substitute for the local concepts/files filter
-- and runs inside a synchronous build request; unindexed it is a containment scan.
CREATE INDEX IF NOT EXISTS idx_observations_metadata
  ON observations USING GIN (metadata jsonb_path_ops);
`;
