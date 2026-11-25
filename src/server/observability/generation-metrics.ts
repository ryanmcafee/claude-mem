// SPDX-License-Identifier: Apache-2.0

import { ServerGenerationScopeViolationError } from '../generation/ProviderObservationGenerator.js';
import { ServerClassifiedProviderError } from '../generation/providers/shared/error-classification.js';
import { getTracer, newSpanId, newTraceId } from './otlp-tracer.js';
import { generationAttemptsTotal, generationDurationSeconds } from './server-metrics.js';

export type GenerationLane = 'event' | 'summary';

export function generationFailureReason(error: unknown): string {
  if (error instanceof ServerGenerationScopeViolationError) return error.reason;
  if (error instanceof ServerClassifiedProviderError) return error.kind;
  return 'unknown';
}

export interface GenerationAttempt {
  lane: GenerationLane;
  startedAt: bigint;
  startUnixNano: bigint;
  bullmqJobId: string | undefined;
  error?: unknown;
}

export function recordGenerationAttempt(attempt: GenerationAttempt): void {
  const elapsedNano = process.hrtime.bigint() - attempt.startedAt;
  const failed = 'error' in attempt;
  const outcome = failed ? 'failed' : 'completed';
  const reason = failed ? generationFailureReason(attempt.error) : '';
  generationAttemptsTotal.inc({ lane: attempt.lane, outcome, reason });
  generationDurationSeconds.observe({ lane: attempt.lane, outcome }, Number(elapsedNano) / 1e9);
  getTracer()?.record({
    name: `generation ${attempt.lane}`,
    kind: 'consumer',
    traceId: newTraceId(),
    spanId: newSpanId(),
    startUnixNano: attempt.startUnixNano,
    endUnixNano: attempt.startUnixNano + elapsedNano,
    attributes: {
      'messaging.system': 'bullmq',
      'messaging.destination.name': attempt.lane,
      'messaging.message.id': attempt.bullmqJobId ?? '',
      'claude_mem.generation.outcome': outcome,
      ...(failed ? { 'claude_mem.generation.failure_reason': reason } : {}),
    },
    ...(failed ? { error: reason } : {}),
  });
}
