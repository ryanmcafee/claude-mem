// SPDX-License-Identifier: Apache-2.0
//
// MCAA-281 — the single projection every observation response goes through.
//
// The shared read predicate is `(project_id = $q AND team_id = $key) OR (opted-in
// AND shared)`. The first branch is the caller's own authorized view; anything
// else in the result set arrived through the shared branch and belongs to a
// different origin — another tenant, or the same tenant's other project outside
// the query's scope. Those rows get an allowlisted projection instead of the
// stored row.
//
// Redaction is centralized here rather than per-route because REST /v1/search,
// REST /v1/context and the three MCP recall tools all read the same rows: a
// per-route filter would leak from whichever surface someone forgot to update.

import { createHash } from 'node:crypto';

export interface SerializableObservation {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  shared?: boolean;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

/** The read a row was reached through: the caller's team and the queried project. */
export interface ObservationViewer {
  teamId: string;
  projectId: string;
}

// Metadata keys admitted back onto a projected row. Deliberately empty: every
// key on a published row is publisher-controlled free-form JSON, and the write
// path injects the publisher's `agentId`. Admitting a key is a trust-boundary
// change and needs the same review this projection got.
const SHARED_METADATA_ALLOWLIST: readonly string[] = [];

const ORIGIN_TOKEN_LENGTH = 16;

// Stable opaque grouping token so a consumer can tell two projected rows came
// from the same publisher without learning who. teamId is a UUID, so the digest
// cannot be walked back by guessing repository or directory names the way a
// digest of the project id alone could.
function sharedOriginToken(teamId: string, projectId: string): string {
  return createHash('sha256')
    .update(`claude-mem:shared-origin:v1:${teamId}:${projectId}`)
    .digest('hex')
    .slice(0, ORIGIN_TOKEN_LENGTH);
}

function admittedSharedMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const admitted: Record<string, unknown> = {};
  for (const key of SHARED_METADATA_ALLOWLIST) {
    if (Object.hasOwn(metadata, key)) admitted[key] = metadata[key];
  }
  return Object.keys(admitted).length > 0 ? admitted : undefined;
}

/**
 * True when the viewer owns the row through the query's own tenant predicate.
 * Same team but a different project is NOT ownership here: that row was only
 * reachable because the caller opted into the shared scope.
 */
export function isOwnerAuthorizedView(
  observation: Pick<SerializableObservation, 'teamId' | 'projectId'>,
  viewer: ObservationViewer,
): boolean {
  return observation.teamId === viewer.teamId && observation.projectId === viewer.projectId;
}

/** Full-fidelity response shape for a row the caller owns. */
export function serializeObservation(observation: SerializableObservation): Record<string, unknown> {
  return {
    id: observation.id,
    projectId: observation.projectId,
    teamId: observation.teamId,
    serverSessionId: observation.serverSessionId,
    kind: observation.kind,
    content: observation.content,
    metadata: observation.metadata,
    shared: observation.shared === true,
    createdAtEpoch: observation.createdAtEpoch,
    updatedAtEpoch: observation.updatedAtEpoch,
  };
}

/**
 * Serialize a row for `viewer`. Owned rows keep full fidelity; anything reached
 * through the shared branch is reduced to the published content plus an opaque
 * origin token. `teamId`, `projectId`, `serverSessionId` and `metadata` never
 * cross that boundary.
 */
export function serializeObservationForViewer(
  observation: SerializableObservation,
  viewer: ObservationViewer,
): Record<string, unknown> {
  if (isOwnerAuthorizedView(observation, viewer)) {
    return serializeObservation(observation);
  }
  const metadata = admittedSharedMetadata(observation.metadata);
  return {
    id: observation.id,
    kind: observation.kind,
    content: observation.content,
    shared: observation.shared === true,
    sharedOrigin: sharedOriginToken(observation.teamId, observation.projectId),
    ...(metadata ? { metadata } : {}),
    createdAtEpoch: observation.createdAtEpoch,
    updatedAtEpoch: observation.updatedAtEpoch,
  };
}
