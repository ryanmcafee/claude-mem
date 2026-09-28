// SPDX-License-Identifier: Apache-2.0
//
// MCAA-241 — migrate a local SQLite claude-mem database into the central
// server.
//
// Two properties define this module:
//
// 1. Every write is scoped. The project id is required and the team comes from
//    the API key server-side (MCAA-237), so an imported row can never land
//    unscoped. The local `project` column and session id travel in metadata,
//    where they are provenance rather than a second, competing scope.
//
// 2. Re-running the import is a no-op. Each source row gets a deterministic
//    idempotency key derived from (table, local session id, row id), which the
//    server maps onto the unique (team, project, generation_key) index. A
//    second run over the same database therefore adds nothing and changes
//    nothing — the server reports the row as already present instead.
//
// The source database is opened read-only: remote mode forbids CREATING a
// local memory database, and an import must never be the thing that
// resurrects one.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

/** Bumping this re-imports every row under fresh keys; do not bump casually. */
export const IMPORT_KEY_VERSION = 'sqlite-v1';

export const IMPORT_SOURCE_TABLES = ['observations', 'session_summaries'] as const;
export type ImportSourceTable = (typeof IMPORT_SOURCE_TABLES)[number];

export interface ImportWriteRequest {
  projectId: string;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  agentId: string | null;
  idempotencyKey: string;
}

export interface ImportWriteResult {
  /** False when the server already held a row for this idempotency key. */
  created: boolean;
}

export interface ImportWriteClient {
  addObservation(request: ImportWriteRequest): Promise<ImportWriteResult>;
}

export interface SqliteImportOptions {
  databasePath: string;
  projectId: string;
  agentId?: string | null;
  /** Restrict to these values of the local `project` column. */
  sourceProjects?: string[];
  dryRun?: boolean;
  onProgress?: (progress: SqliteImportProgress) => void;
}

export interface SqliteImportProgress extends SqliteImportCounts {
  table: ImportSourceTable;
}

export interface SqliteImportCounts {
  scanned: number;
  created: number;
  alreadyPresent: number;
  /** Source rows with no renderable text; nothing is sent for them. */
  skippedEmpty: number;
  failed: number;
}

export interface SqliteImportFailure {
  table: ImportSourceTable;
  rowId: number;
  error: string;
}

export interface SqliteImportResult {
  databasePath: string;
  projectId: string;
  agentId: string | null;
  dryRun: boolean;
  observations: SqliteImportCounts;
  summaries: SqliteImportCounts;
  totals: SqliteImportCounts;
  failures: SqliteImportFailure[];
}

export class SqliteImportSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteImportSourceError';
  }
}

interface ObservationRow {
  id: number;
  memory_session_id: string | null;
  project: string | null;
  type: string | null;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string | null;
  created_at_epoch: number | null;
  platform_source: string | null;
}

interface SummaryRow {
  id: number;
  memory_session_id: string | null;
  project: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  created_at: string | null;
  created_at_epoch: number | null;
  platform_source: string | null;
}

/**
 * Deterministic idempotency key for one source row. Local row ids are only
 * unique per database, so the local session id (a uuid) is part of the key: two
 * machines importing into the same project keep their rows distinct, while the
 * same machine importing twice collides with itself on purpose.
 */
export function buildImportIdempotencyKey(input: {
  table: ImportSourceTable;
  sessionId: string | null;
  rowId: number;
}): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([IMPORT_KEY_VERSION, input.table, input.sessionId ?? '', input.rowId]))
    .digest('hex');
  return `import:${IMPORT_KEY_VERSION}:${input.table}:${fingerprint}`;
}

export function renderObservationContent(row: {
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
}): string {
  const sections: string[] = [];
  appendText(sections, row.title);
  appendText(sections, row.subtitle);
  appendText(sections, row.narrative ?? row.text);
  if (row.narrative && row.text && row.text.trim() !== row.narrative.trim()) {
    appendText(sections, row.text);
  }
  appendList(sections, 'Facts', row.facts);
  appendList(sections, 'Concepts', row.concepts);
  return sections.join('\n\n');
}

export function renderSummaryContent(row: {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
}): string {
  const sections: string[] = [];
  appendLabelled(sections, 'Request', row.request);
  appendLabelled(sections, 'Investigated', row.investigated);
  appendLabelled(sections, 'Learned', row.learned);
  appendLabelled(sections, 'Completed', row.completed);
  appendLabelled(sections, 'Next steps', row.next_steps);
  appendLabelled(sections, 'Notes', row.notes);
  return sections.join('\n\n');
}

export async function importSqliteDatabase(
  options: SqliteImportOptions,
  client: ImportWriteClient,
): Promise<SqliteImportResult> {
  const projectId = options.projectId.trim();
  if (!projectId) {
    throw new SqliteImportSourceError(
      'A project id is required: every imported row must carry a tenant scope.',
    );
  }

  const db = new Database(options.databasePath, { readonly: true });
  try {
    const observations = emptyCounts();
    const summaries = emptyCounts();
    const failures: SqliteImportFailure[] = [];
    const agentId = (options.agentId ?? '').trim() || null;
    const dryRun = options.dryRun === true;

    if (!tableExists(db, 'observations') && !tableExists(db, 'session_summaries')) {
      throw new SqliteImportSourceError(
        `${options.databasePath} has neither an \`observations\` nor a \`session_summaries\` table — `
        + 'it does not look like a claude-mem database.',
      );
    }

    for (const row of selectObservations(db, options.sourceProjects)) {
      observations.scanned += 1;
      const content = renderObservationContent(row);
      if (content.trim().length === 0) {
        observations.skippedEmpty += 1;
        continue;
      }
      await writeRow({
        client,
        dryRun,
        counts: observations,
        failures,
        table: 'observations',
        rowId: row.id,
        request: {
          projectId,
          agentId,
          kind: 'observation',
          content,
          idempotencyKey: buildImportIdempotencyKey({
            table: 'observations',
            sessionId: row.memory_session_id,
            rowId: row.id,
          }),
          metadata: {
            ...baseMetadata('observations', row.id, row),
            observationType: row.type,
            promptNumber: row.prompt_number,
            filesRead: parseJsonArray(row.files_read),
            filesModified: parseJsonArray(row.files_modified),
          },
        },
      });
      options.onProgress?.({ table: 'observations', ...observations });
    }

    for (const row of selectSummaries(db, options.sourceProjects)) {
      summaries.scanned += 1;
      const content = renderSummaryContent(row);
      if (content.trim().length === 0) {
        summaries.skippedEmpty += 1;
        continue;
      }
      await writeRow({
        client,
        dryRun,
        counts: summaries,
        failures,
        table: 'session_summaries',
        rowId: row.id,
        request: {
          projectId,
          agentId,
          kind: 'summary',
          content,
          idempotencyKey: buildImportIdempotencyKey({
            table: 'session_summaries',
            sessionId: row.memory_session_id,
            rowId: row.id,
          }),
          metadata: {
            ...baseMetadata('session_summaries', row.id, row),
            filesRead: parseJsonArray(row.files_read),
            filesModified: parseJsonArray(row.files_edited),
          },
        },
      });
      options.onProgress?.({ table: 'session_summaries', ...summaries });
    }

    return {
      databasePath: options.databasePath,
      projectId,
      agentId,
      dryRun,
      observations,
      summaries,
      totals: addCounts(observations, summaries),
      failures,
    };
  } finally {
    db.close();
  }
}

async function writeRow(input: {
  client: ImportWriteClient;
  dryRun: boolean;
  counts: SqliteImportCounts;
  failures: SqliteImportFailure[];
  table: ImportSourceTable;
  rowId: number;
  request: ImportWriteRequest;
}): Promise<void> {
  if (input.dryRun) {
    input.counts.created += 1;
    return;
  }
  try {
    const result = await input.client.addObservation(input.request);
    if (result.created) {
      input.counts.created += 1;
    } else {
      input.counts.alreadyPresent += 1;
    }
  } catch (error) {
    input.counts.failed += 1;
    input.failures.push({
      table: input.table,
      rowId: input.rowId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Streams rather than materializing: a long-lived local database can hold tens
 * of thousands of observations, and loading them all before the first write
 * would make the import's memory use grow with the user's history.
 */
function selectObservations(db: Database, sourceProjects?: string[]): IterableIterator<ObservationRow> {
  if (!tableExists(db, 'observations')) return [][Symbol.iterator]();
  const columns = availableColumns(db, 'observations');
  const select = [
    'o.id AS id',
    projected(columns, 'memory_session_id'),
    projected(columns, 'project'),
    projected(columns, 'type'),
    projected(columns, 'title'),
    projected(columns, 'subtitle'),
    projected(columns, 'text'),
    projected(columns, 'narrative'),
    projected(columns, 'facts'),
    projected(columns, 'concepts'),
    projected(columns, 'files_read'),
    projected(columns, 'files_modified'),
    projected(columns, 'prompt_number'),
    projected(columns, 'created_at'),
    projected(columns, 'created_at_epoch'),
    sessionPlatformSource(db),
  ].join(', ');
  const filter = projectFilter(columns, sourceProjects);
  return db
    .query<ObservationRow, string[]>(
      `SELECT ${select} FROM observations o ${sessionJoin(db)} ${filter.sql} ORDER BY o.id ASC`,
    )
    .iterate(...filter.params);
}

function selectSummaries(db: Database, sourceProjects?: string[]): IterableIterator<SummaryRow> {
  if (!tableExists(db, 'session_summaries')) return [][Symbol.iterator]();
  const columns = availableColumns(db, 'session_summaries');
  const select = [
    'o.id AS id',
    projected(columns, 'memory_session_id'),
    projected(columns, 'project'),
    projected(columns, 'request'),
    projected(columns, 'investigated'),
    projected(columns, 'learned'),
    projected(columns, 'completed'),
    projected(columns, 'next_steps'),
    projected(columns, 'files_read'),
    projected(columns, 'files_edited'),
    projected(columns, 'notes'),
    projected(columns, 'created_at'),
    projected(columns, 'created_at_epoch'),
    sessionPlatformSource(db),
  ].join(', ');
  const filter = projectFilter(columns, sourceProjects);
  return db
    .query<SummaryRow, string[]>(
      `SELECT ${select} FROM session_summaries o ${sessionJoin(db)} ${filter.sql} ORDER BY o.id ASC`,
    )
    .iterate(...filter.params);
}

/**
 * Older local databases predate several columns, so every optional column is
 * projected as NULL when absent. An import that only works on the newest
 * schema is an import nobody can run on the database they actually have.
 */
function projected(columns: Set<string>, column: string): string {
  return columns.has(column) ? `o.${column} AS ${column}` : `NULL AS ${column}`;
}

function sessionJoin(db: Database): string {
  return tableExists(db, 'sdk_sessions')
    ? 'LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id'
    : '';
}

function sessionPlatformSource(db: Database): string {
  if (!tableExists(db, 'sdk_sessions')) return 'NULL AS platform_source';
  return availableColumns(db, 'sdk_sessions').has('platform_source')
    ? 's.platform_source AS platform_source'
    : 'NULL AS platform_source';
}

function projectFilter(
  columns: Set<string>,
  sourceProjects?: string[],
): { sql: string; params: string[] } {
  const wanted = (sourceProjects ?? []).map(value => value.trim()).filter(value => value.length > 0);
  if (wanted.length === 0 || !columns.has('project')) return { sql: '', params: [] };
  const placeholders = wanted.map(() => '?').join(', ');
  return { sql: `WHERE o.project IN (${placeholders})`, params: wanted };
}

function baseMetadata(
  table: ImportSourceTable,
  rowId: number,
  row: { memory_session_id: string | null; project: string | null; created_at: string | null; created_at_epoch: number | null; platform_source: string | null },
): Record<string, unknown> {
  return {
    source: 'sqlite-import',
    importKeyVersion: IMPORT_KEY_VERSION,
    sourceTable: table,
    sourceRowId: rowId,
    sourceProject: row.project,
    sourceSessionId: row.memory_session_id,
    platformSource: row.platform_source,
    sourceCreatedAt: row.created_at,
    sourceCreatedAtEpoch: row.created_at_epoch,
  };
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  return row !== null;
}

function availableColumns(db: Database, table: string): Set<string> {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map(row => row.name));
}

function appendText(sections: string[], value: string | null | undefined): void {
  const trimmed = (value ?? '').trim();
  if (trimmed.length > 0) sections.push(trimmed);
}

function appendLabelled(sections: string[], label: string, value: string | null | undefined): void {
  const trimmed = (value ?? '').trim();
  if (trimmed.length > 0) sections.push(`${label}: ${trimmed}`);
}

function appendList(sections: string[], label: string, raw: string | null | undefined): void {
  const values = parseJsonArray(raw);
  if (values.length === 0) {
    appendLabelled(sections, label, raw);
    return;
  }
  sections.push(`${label}:\n${values.map(value => `- ${value}`).join('\n')}`);
}

function parseJsonArray(raw: string | null | undefined): string[] {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(value => (typeof value === 'string' ? value : JSON.stringify(value)))
    .filter(value => value.trim().length > 0);
}

function emptyCounts(): SqliteImportCounts {
  return { scanned: 0, created: 0, alreadyPresent: 0, skippedEmpty: 0, failed: 0 };
}

function addCounts(left: SqliteImportCounts, right: SqliteImportCounts): SqliteImportCounts {
  return {
    scanned: left.scanned + right.scanned,
    created: left.created + right.created,
    alreadyPresent: left.alreadyPresent + right.alreadyPresent,
    skippedEmpty: left.skippedEmpty + right.skippedEmpty,
    failed: left.failed + right.failed,
  };
}
