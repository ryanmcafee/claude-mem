#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//
// MCAA-241 — walk the portable backup path end to end against throwaway
// databases: seed the real server schema, `pg_dump -Fc`, restore into a second
// database, then prove the restored copy matches row for row.
//
// This is the executable half of docs/postgres-backup-restore.md. A restore
// procedure that is only written down is a procedure nobody has run, so CI runs
// this drill on the same Postgres the gated suites use.
//
// Usage:
//   bun scripts/pg-backup-restore-drill.ts [--url <dsn>] [--keep]
//
// The DSN defaults to CLAUDE_MEM_TEST_POSTGRES_URL. Both throwaway databases
// are dropped and recreated on every run, and dropped again at the end unless
// --keep is passed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { bootstrapServerPostgresSchema } from '../src/storage/postgres/schema.js';
import { createPostgresStorageRepositories } from '../src/storage/postgres/index.js';

const SOURCE_DB = 'claude_mem_drill_source';
const RESTORED_DB = 'claude_mem_drill_restored';

interface Snapshot {
  teams: number;
  projects: number;
  observations: number;
  contentDigest: string;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const urlFlag = args.indexOf('--url');
  const dsn = (urlFlag !== -1 ? args[urlFlag + 1] : undefined)
    ?? process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
  const keep = args.includes('--keep');

  if (!dsn) {
    console.error('No Postgres DSN: pass --url <dsn> or set CLAUDE_MEM_TEST_POSTGRES_URL.');
    return 1;
  }

  reportToolVersions();

  const sourceDsn = withDatabase(dsn, SOURCE_DB);
  const restoredDsn = withDatabase(dsn, RESTORED_DB);
  const workDir = mkdtempSync(join(tmpdir(), 'cmem-pg-drill-'));
  const dumpPath = join(workDir, 'claude-mem.dump');

  try {
    console.log(`\n1. Prepare throwaway databases (${SOURCE_DB}, ${RESTORED_DB})`);
    await recreateDatabase(dsn, SOURCE_DB);
    await recreateDatabase(dsn, RESTORED_DB);

    console.log('\n2. Seed the source database with the server schema and sample rows');
    const before = await seedAndSnapshot(sourceDsn);
    printSnapshot('source', before);

    console.log(`\n3. Back up: pg_dump --format=custom ${SOURCE_DB} -> ${dumpPath}`);
    run('pg_dump', ['--dbname', sourceDsn, '--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath]);

    console.log(`\n4. Restore: pg_restore into ${RESTORED_DB}`);
    run('pg_restore', ['--dbname', restoredDsn, '--no-owner', '--no-privileges', dumpPath]);

    console.log('\n5. Verify the restored copy');
    const after = await snapshot(restoredDsn);
    printSnapshot('restored', after);

    const mismatches = compare(before, after);
    if (mismatches.length > 0) {
      console.error('\nRestore verification FAILED:');
      for (const mismatch of mismatches) console.error(`  ${mismatch}`);
      return 1;
    }
    console.log('\nRestore verified: row counts and observation content digests match.');
    return 0;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    if (keep) {
      console.log(`\nKept ${SOURCE_DB} and ${RESTORED_DB} (--keep).`);
    } else {
      await dropDatabase(dsn, SOURCE_DB);
      await dropDatabase(dsn, RESTORED_DB);
      console.log(`\nDropped ${SOURCE_DB} and ${RESTORED_DB}.`);
    }
  }
}

function reportToolVersions(): void {
  for (const tool of ['pg_dump', 'pg_restore']) {
    console.log(`${tool}: ${run(tool, ['--version']).trim()}`);
  }
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    throw new Error(`${command} failed: ${stderr.trim() || (error instanceof Error ? error.message : String(error))}`);
  }
}

function withDatabase(dsn: string, database: string): string {
  const url = new URL(dsn);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdminClient<T>(dsn: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(dsn, 'postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function recreateDatabase(dsn: string, name: string): Promise<void> {
  await withAdminClient(dsn, async client => {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  });
}

async function dropDatabase(dsn: string, name: string): Promise<void> {
  await withAdminClient(dsn, async client => {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  });
}

async function seedAndSnapshot(dsn: string): Promise<Snapshot> {
  const pool = new pg.Pool({ connectionString: dsn });
  try {
    const client = await pool.connect();
    try {
      await bootstrapServerPostgresSchema(client);
    } finally {
      client.release();
    }
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'drill-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'drill-project' });
    for (const [index, content] of [
      'the worker refused to start because a ghost listener held the port',
      'imported from a local SQLite database on 2026-09-28',
      'restore drill row with a UTF-8 body: naïve café',
    ].entries()) {
      await storage.observations.create({
        projectId: project.id,
        teamId: team.id,
        content,
        generationKey: `drill:v1:${index}`,
      });
    }
    return await snapshotWithPool(pool);
  } finally {
    await pool.end();
  }
}

async function snapshot(dsn: string): Promise<Snapshot> {
  const pool = new pg.Pool({ connectionString: dsn });
  try {
    return await snapshotWithPool(pool);
  } finally {
    await pool.end();
  }
}

async function snapshotWithPool(pool: pg.Pool): Promise<Snapshot> {
  const counts = await pool.query<{ teams: string; projects: string; observations: string }>(`
    SELECT
      (SELECT COUNT(*) FROM teams)::text AS teams,
      (SELECT COUNT(*) FROM projects)::text AS projects,
      (SELECT COUNT(*) FROM observations)::text AS observations
  `);
  const digest = await pool.query<{ digest: string | null }>(`
    SELECT md5(string_agg(content, E'\\n' ORDER BY content)) AS digest FROM observations
  `);
  const row = counts.rows[0];
  return {
    teams: Number(row?.teams ?? '0'),
    projects: Number(row?.projects ?? '0'),
    observations: Number(row?.observations ?? '0'),
    contentDigest: digest.rows[0]?.digest ?? '(empty)',
  };
}

function compare(before: Snapshot, after: Snapshot): string[] {
  const mismatches: string[] = [];
  for (const key of ['teams', 'projects', 'observations'] as const) {
    if (before[key] !== after[key]) {
      mismatches.push(`${key}: source ${before[key]} != restored ${after[key]}`);
    }
  }
  if (before.contentDigest !== after.contentDigest) {
    mismatches.push(`observation content digest: source ${before.contentDigest} != restored ${after.contentDigest}`);
  }
  return mismatches;
}

function printSnapshot(label: string, value: Snapshot): void {
  console.log(
    `   ${label.padEnd(9)} teams=${value.teams} projects=${value.projects} `
    + `observations=${value.observations} digest=${value.contentDigest}`,
  );
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

main()
  .then(code => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
