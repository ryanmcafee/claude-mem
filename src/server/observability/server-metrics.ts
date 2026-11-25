// SPDX-License-Identifier: Apache-2.0
//
// The claude-mem metric set. Names and labels are a contract with the Helm chart's
// PrometheusRule and Grafana dashboard; rename only alongside them.

import type { Application, NextFunction, Request, Response } from 'express';
import type { ServerGenerationResult } from '../generation/providers/shared/types.js';
import type { ServerQueueLaneMetric } from '../runtime/types.js';
import { CollectedGauge, Counter, Histogram, MetricsRegistry, type GaugeSample } from './metrics-registry.js';
import { getTracer, newSpanId, newTraceId, nowUnixNano, parseTraceparent } from './otlp-tracer.js';

export type MetricsComponent = 'server' | 'worker';

declare const __DEFAULT_PACKAGE_VERSION__: string;
const BUILD_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : 'development';

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const GENERATION_BUCKETS = [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300];
const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const;
const UNMATCHED_ROUTE = 'unmatched';

export const metricsRegistry = new MetricsRegistry();
const processStartSeconds = Math.round(Date.now() / 1000 - process.uptime());
let component: MetricsComponent = 'server';

export function setMetricsComponent(next: MetricsComponent): void {
  component = next;
}

metricsRegistry.register(new CollectedGauge(
  'claude_mem_build_info',
  'Always 1; labels carry the running version and component (server or worker).',
  () => [{ labels: { version: BUILD_VERSION, component }, value: 1 }],
));
metricsRegistry.register(new CollectedGauge(
  'process_start_time_seconds',
  'Start time of the process since unix epoch in seconds.',
  () => [{ labels: {}, value: processStartSeconds }],
));
metricsRegistry.register(new CollectedGauge(
  'process_resident_memory_bytes',
  'Resident memory size in bytes.',
  () => [{ labels: {}, value: process.memoryUsage().rss }],
));
metricsRegistry.register(new CollectedGauge(
  'process_cpu_seconds_total',
  'Total user and system CPU time spent in seconds.',
  () => {
    const usage = process.cpuUsage();
    return [{ labels: {}, value: (usage.user + usage.system) / 1e6 }];
  },
));

export const httpRequestsTotal = metricsRegistry.register(new Counter(
  'claude_mem_http_requests_total',
  'HTTP requests completed by the server, by matched route template.',
  ['method', 'route', 'status_code'],
));

export const httpRequestDurationSeconds = metricsRegistry.register(new Histogram(
  'claude_mem_http_request_duration_seconds',
  'HTTP request latency in seconds, by matched route template.',
  ['method', 'route', 'status_code'],
  LATENCY_BUCKETS,
));

export const generationAttemptsTotal = metricsRegistry.register(new Counter(
  'claude_mem_generation_attempts_total',
  'Generation job attempts processed by this worker; reason is the failure classification, empty on success.',
  ['lane', 'outcome', 'reason'],
));

export const generationDurationSeconds = metricsRegistry.register(new Histogram(
  'claude_mem_generation_duration_seconds',
  'Wall time of one generation job attempt in seconds.',
  ['lane', 'outcome'],
  GENERATION_BUCKETS,
));

export const providerTokensTotal = metricsRegistry.register(new Counter(
  'claude_mem_provider_tokens_total',
  'Tokens (input plus output) reported by the generation provider.',
  ['provider', 'model'],
));

export function recordProviderTokens(result: ServerGenerationResult): void {
  if (!result.tokensUsed || result.tokensUsed <= 0) return;
  providerTokensTotal.inc({ provider: result.providerLabel, model: result.modelId ?? 'unknown' }, result.tokensUsed);
}

// Express sets req.route only on a match, so unmatched paths share one label value.
export function routeLabel(req: Request): string {
  const routePath: unknown = req.route?.path;
  if (typeof routePath !== 'string') return UNMATCHED_ROUTE;
  return `${req.baseUrl}${routePath}`;
}

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const startUnixNano = nowUnixNano();
  res.once('finish', () => {
    const elapsedNano = process.hrtime.bigint() - startedAt;
    const route = routeLabel(req);
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, Number(elapsedNano) / 1e9);
    const tracer = getTracer();
    if (!tracer) return;
    const parent = parseTraceparent(req.header('traceparent'));
    tracer.record({
      name: `${req.method} ${route}`,
      kind: 'server',
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      startUnixNano,
      endUnixNano: startUnixNano + elapsedNano,
      attributes: { 'http.request.method': req.method, 'http.route': route, 'http.response.status_code': res.statusCode },
      ...(res.statusCode >= 500 ? { error: `HTTP ${res.statusCode}` } : {}),
    });
  });
  next();
}

export const httpMetricsRoutes = {
  setupRoutes(app: Application): void {
    app.use(httpMetricsMiddleware);
  },
};

export function queueSamples(lanes: readonly ServerQueueLaneMetric[]): { jobs: GaugeSample[]; up: GaugeSample[] } {
  return {
    jobs: lanes
      .filter(lane => !lane.unavailable)
      .flatMap(lane => QUEUE_STATES.map(state => ({ labels: { lane: lane.kind, state }, value: lane[state] }))),
    up: lanes.map(lane => ({ labels: { lane: lane.kind }, value: lane.unavailable ? 0 : 1 })),
  };
}

// Registers queue gauges backed by one lane sample per scrape.
export function registerQueueMetrics(readLanes: () => Promise<ServerQueueLaneMetric[]>): () => void {
  let pending: Promise<{ jobs: GaugeSample[]; up: GaugeSample[] }> | null = null;
  const sample = () => {
    pending ??= readLanes()
      .then(queueSamples)
      .finally(() => { pending = null; });
    return pending;
  };
  metricsRegistry.register(new CollectedGauge(
    'claude_mem_queue_jobs',
    'BullMQ jobs per generation lane and state, sampled from Redis at scrape time.',
    async () => (await sample()).jobs,
  ));
  metricsRegistry.register(new CollectedGauge(
    'claude_mem_queue_up',
    '1 when the lane counts were read from Redis at scrape time, 0 when Redis was unreachable.',
    async () => (await sample()).up,
  ));
  return () => {
    metricsRegistry.unregister('claude_mem_queue_jobs');
    metricsRegistry.unregister('claude_mem_queue_up');
  };
}
