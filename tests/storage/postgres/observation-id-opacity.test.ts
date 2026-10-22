// SPDX-License-Identifier: Apache-2.0
//
// ADR 0002 D9 condition 20 — an observation's id is kept on a projected row on
// the condition that the id is opaque. That condition used to rest on the
// convention that no route passes an id; here it is the writer's own property.
//
// No database: the point under test is that the refusal happens at the write
// boundary, before any SQL runs, so the repositories are driven with a fake
// queryable that records every statement.

import { describe, expect, it } from 'bun:test';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  PostgresObservationRepository,
  PostgresObservationSourcesRepository,
} from '../../../src/storage/postgres/observations.js';
import { isOpaqueId, newId, type PostgresQueryable } from '../../../src/storage/postgres/utils.js';

class FakeQueryable implements PostgresQueryable {
  readonly statements: string[] = [];
  readonly values: unknown[][] = [];

  constructor(private readonly answer: (sql: string, values: unknown[]) => QueryResultRow[]) {}

  async query(text: string, values: unknown[] = []): Promise<QueryResult<QueryResultRow>> {
    this.statements.push(text);
    this.values.push(values);
    const rows = this.answer(text, values);
    return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
  }
}

/** Fails the test if the writer reaches the database at all. */
function refusesEveryQuery(): FakeQueryable {
  return new FakeQueryable((sql) => {
    throw new Error(`the writer must not query before validating the id: ${sql}`);
  });
}

const PROJECT_ID = 'homelab';
const TEAM_ID = 'team-a';

function observationWriter(): FakeQueryable {
  return new FakeQueryable((sql, values) => {
    if (sql.includes('FROM projects')) return [{ id: PROJECT_ID }];
    if (sql.includes('INSERT INTO observations')) {
      return [{
        id: values[0],
        project_id: values[1],
        team_id: values[2],
        server_session_id: values[3],
        kind: values[4],
        content: values[5],
        generation_key: values[6],
        metadata: {},
        embedding: null,
        created_by_job_id: null,
        shared: values[10],
        created_at: new Date(0),
        updated_at: new Date(0),
      }];
    }
    throw new Error(`unexpected statement: ${sql}`);
  });
}

// Every one of these says something about the row beyond "this row": a name, a
// position in a sequence, a timestamp, a hash of the content, or a version that
// marks the id as derived rather than random.
const CALLER_CHOSEN_IDS = [
  'ops-runbook-2026-01-05',
  'observation-1',
  '42',
  'sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
  '00000000-0000-5000-8000-000000000000',
  'not-a-uuid',
  '',
];

describe('ADR 0002 D9 condition 20 — observation ids are opaque at the writer', () => {
  it('keeps the rule tracking the generator', () => {
    expect(isOpaqueId(newId())).toBe(true);
  });

  it('refuses a caller-chosen observation id before it reaches SQL', async () => {
    const client = refusesEveryQuery();
    const repo = new PostgresObservationRepository(client);

    for (const id of CALLER_CHOSEN_IDS) {
      await expect(repo.create({
        id,
        projectId: PROJECT_ID,
        teamId: TEAM_ID,
        content: 'a published fact',
        shared: true,
      })).rejects.toThrow(/server-generated random id/);
    }
    expect(client.statements).toEqual([]);
  });

  it('refuses a caller-chosen observation source id before it reaches SQL', async () => {
    const client = refusesEveryQuery();
    const repo = new PostgresObservationSourcesRepository(client);

    for (const id of CALLER_CHOSEN_IDS) {
      await expect(repo.addSource({
        id,
        observationId: newId(),
        projectId: PROJECT_ID,
        teamId: TEAM_ID,
        sourceType: 'manual',
        sourceId: 'operator',
      })).rejects.toThrow(/server-generated random id/);
    }
    expect(client.statements).toEqual([]);
  });

  it('mints an opaque id when the caller supplies none', async () => {
    const client = observationWriter();
    const created = await new PostgresObservationRepository(client).create({
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
      content: 'a fact with no id of its own',
    });

    expect(isOpaqueId(created.id)).toBe(true);
  });

  it('accepts a server-minted id, so an id-preserving import still writes', async () => {
    const preserved = newId();
    const client = observationWriter();
    const created = await new PostgresObservationRepository(client).create({
      id: preserved,
      projectId: PROJECT_ID,
      teamId: TEAM_ID,
      content: 'a fact carried over from another store',
      shared: true,
    });

    expect(created.id).toBe(preserved);
    expect(client.statements.some(sql => sql.includes('INSERT INTO observations'))).toBe(true);
  });
});
