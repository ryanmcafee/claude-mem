// SPDX-License-Identifier: Apache-2.0
//
// MCAA-281 — unit coverage for the shared-response projection.
//
// tests/server/runtime/tenant-isolation-routes.test.ts proves the projection is
// actually wired into every read surface against a real Postgres. This file
// pins the projection's own rules, which are cheap to assert exhaustively:
// which fields survive, that nested publisher JSON is dropped wholesale, and
// that the origin token is stable without being reversible.

import { describe, expect, it } from 'bun:test';
import {
  isOwnerAuthorizedView,
  serializeObservation,
  serializeObservationForViewer,
  type SerializableObservation,
} from '../../../src/server/routes/v1/observation-projection.js';

const TEAM_A = '11111111-1111-4111-8111-111111111111';
const TEAM_B = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<SerializableObservation> = {}): SerializableObservation {
  return {
    id: 'obs-1',
    projectId: 'acme-internal-pki',
    teamId: TEAM_A,
    serverSessionId: 'session-abc',
    kind: 'manual',
    content: 'rotate the intermediate CA before the leaf expires',
    metadata: {
      agentId: 'agent-7',
      project: 'acme-internal-pki',
      nested: { projectId: 'acme-internal-pki', serverSessionId: 'session-abc' },
    },
    shared: true,
    createdAtEpoch: 1_700_000_000_000,
    updatedAtEpoch: 1_700_000_001_000,
    ...overrides,
  };
}

describe('MCAA-281 — observation projection', () => {
  it('keeps full fidelity for the row the caller owns', () => {
    const observation = row();
    const projected = serializeObservationForViewer(observation, {
      teamId: TEAM_A,
      projectId: 'acme-internal-pki',
    });
    expect(projected).toEqual(serializeObservation(observation));
    expect(projected.projectId).toBe('acme-internal-pki');
    expect(projected.serverSessionId).toBe('session-abc');
    expect(projected.metadata).toEqual(observation.metadata);
  });

  it('drops the publisher identifiers and all metadata on a cross-tenant row', () => {
    const projected = serializeObservationForViewer(row(), {
      teamId: TEAM_B,
      projectId: 'bravo-web',
    });
    expect(Object.keys(projected).sort()).toEqual([
      'content',
      'createdAtEpoch',
      'id',
      'kind',
      'shared',
      'sharedOrigin',
      'updatedAtEpoch',
    ]);
    expect(JSON.stringify(projected)).not.toContain('acme-internal-pki');
    expect(JSON.stringify(projected)).not.toContain('session-abc');
    expect(JSON.stringify(projected)).not.toContain('agent-7');
    expect(JSON.stringify(projected)).not.toContain(TEAM_A);
  });

  it('projects a same-team row from another project, reachable only via the shared branch', () => {
    const projected = serializeObservationForViewer(row({ projectId: 'acme-payments' }), {
      teamId: TEAM_A,
      projectId: 'acme-internal-pki',
    });
    expect(projected.projectId).toBeUndefined();
    expect(projected.metadata).toBeUndefined();
    expect(projected.sharedOrigin).toBeString();
  });

  it('treats same team plus same project as the only owner-authorized view', () => {
    expect(isOwnerAuthorizedView({ teamId: TEAM_A, projectId: 'p1' }, { teamId: TEAM_A, projectId: 'p1' })).toBe(true);
    expect(isOwnerAuthorizedView({ teamId: TEAM_A, projectId: 'p2' }, { teamId: TEAM_A, projectId: 'p1' })).toBe(false);
    expect(isOwnerAuthorizedView({ teamId: TEAM_B, projectId: 'p1' }, { teamId: TEAM_A, projectId: 'p1' })).toBe(false);
  });

  it('gives one origin the same token across rows and different origins different tokens', () => {
    const viewer = { teamId: TEAM_B, projectId: 'bravo-web' };
    const first = serializeObservationForViewer(row({ id: 'obs-1' }), viewer);
    const second = serializeObservationForViewer(row({ id: 'obs-2' }), viewer);
    const otherProject = serializeObservationForViewer(row({ projectId: 'acme-payments' }), viewer);
    const otherTeam = serializeObservationForViewer(row({ teamId: TEAM_B }), {
      teamId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      projectId: 'charlie',
    });

    expect(first.sharedOrigin).toBe(second.sharedOrigin);
    expect(first.sharedOrigin).not.toBe(otherProject.sharedOrigin);
    expect(first.sharedOrigin).not.toBe(otherTeam.sharedOrigin);
  });
});
