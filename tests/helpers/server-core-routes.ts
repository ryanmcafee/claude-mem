/**
 * Response shapes for the core routes `Server.setupCoreRoutes` registers. Two
 * suites assert on them, so the shape lives here where a reviewer can diff it
 * against `src/services/server/Server.ts` once instead of per suite.
 */
import type { ObservationQueueHealth } from '../../src/server/queue/queue-health-types.js';

export type HealthBody = {
  status: 'ok' | 'degraded';
  version: string;
  platform: string;
  pid: number;
  initialized: boolean;
  mcpReady: boolean;
  queue?: ObservationQueueHealth;
};

export type ReadinessBody = {
  status: 'ready' | 'initializing';
  mcpReady?: boolean;
  message?: string;
};

export type VersionBody = { version: string };

export type ErrorBody = { error: string; message?: string };
