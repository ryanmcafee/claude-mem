// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { ProviderObservationGenerator } from '../../../src/server/generation/ProviderObservationGenerator.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import type { ServerGenerationProvider } from '../../../src/server/generation/providers/shared/types.js';
import type { Job } from 'bullmq';
import type { GenerateObservationsForEventJob } from '../../../src/server/jobs/types.js';
import { createIsolatedSchema, dropSchema, poolForSchema } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

class StubProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  calls = 0;

  constructor(private readonly response: string | Error) {}

  async generate() {
    this.calls += 1;
    if (this.response instanceof Error) throw this.response;
    return { rawText: this.response, providerLabel: this.providerLabel };
  }
}

describe('ProviderObservationGenerator', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;
  let eventId: string;
  let jobId: string;

  beforeEach(async () => {
    // The generator parses provider XML through the active ModeManager mode;
    // load it here so this file does not depend on another file's side effect.
    ModeManager.getInstance().loadMode('code');
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_phase5_gen');
    pool = poolForSchema(testDatabaseUrl, schemaName);
    await bootstrapServerPostgresSchema(pool);
    storage = createPostgresStorageRepositories(pool);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { x: 1 },
      occurredAt: new Date(),
    });
    eventId = event.id;
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'observation_generate_for_event',
    });
    jobId = job.id;
  });

  afterEach(async () => {
    await pool.end();
    await dropSchema(testDatabaseUrl, schemaName);
  });

  function makeJob(): Job<GenerateObservationsForEventJob> {
    return {
      id: 'bull-1',
      data: {
        kind: 'event',
        team_id: teamId,
        project_id: projectId,
        source_type: 'agent_event',
        source_id: eventId,
        generation_job_id: jobId,
        agent_event_id: eventId,
        api_key_id: null,
        actor_id: null,
        source_adapter: 'api',
      },
    } as unknown as Job<GenerateObservationsForEventJob>;
  }

  it('completes a job using the fake provider response', async () => {
    const xml = '<observation><type>discovery</type><title>OK</title><facts><fact>f</fact></facts></observation>';
    const provider = new StubProvider(xml);
    const generator = new ProviderObservationGenerator({ pool, provider });

    const result = await generator.process(makeJob());
    expect(result.status).toBe('completed');
    expect(result.observationCount).toBe(1);
    expect(provider.calls).toBe(1);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('completed');
  });

  it('marks a job as failed (no retry) when provider returns malformed XML', async () => {
    const provider = new StubProvider('not xml at all');
    const generator = new ProviderObservationGenerator({ pool, provider });

    await expect(generator.process(makeJob())).rejects.toThrow(/parse error/);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('failed');
  });
});
