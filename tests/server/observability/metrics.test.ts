import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type http from 'http';
import pg from 'pg';
import { ServerGenerationScopeViolationError } from '../../../src/server/generation/ProviderObservationGenerator.js';
import { ServerClassifiedProviderError } from '../../../src/server/generation/providers/shared/error-classification.js';
import { generationFailureReason, initGenerationAttemptSeries, recordGenerationAttempt } from '../../../src/server/observability/generation-metrics.js';
import { CollectedGauge, Counter, Histogram, MetricsRegistry } from '../../../src/server/observability/metrics-registry.js';
import {
  METRICS_CONTENT_TYPE,
  resolveMetricsListenerConfig,
  startMetricsServer,
  stopMetricsServer,
} from '../../../src/server/observability/metrics-server.js';
import {
  generationAttemptsTotal,
  metricsRegistry,
  providerTokensTotal,
  queueSamples,
  recordProviderTokens,
  registerQueueMetrics,
} from '../../../src/server/observability/server-metrics.js';
import { ServerService } from '../../../src/server/runtime/ServerService.js';
import {
  DisabledServerGenerationWorkerManager,
  DisabledServerQueueManager,
  type ServerQueueLaneMetric,
} from '../../../src/server/runtime/types.js';
import { logger } from '../../../src/utils/logger.js';

const lane = (overrides: Partial<ServerQueueLaneMetric>): ServerQueueLaneMetric => ({
  kind: 'event',
  name: 'claude_mem_event',
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  stalled: 0,
  unavailable: false,
  ...overrides,
});

const loggerSpies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  for (const level of ['info', 'debug', 'warn', 'error'] as const) {
    loggerSpies.push(spyOn(logger, level).mockImplementation(() => {}));
  }
});
afterEach(() => loggerSpies.splice(0).forEach(spy => spy.mockRestore()));

describe('MetricsRegistry exposition', () => {
  it('renders counters, histograms and collected gauges in text format 0.0.4', async () => {
    const registry = new MetricsRegistry();
    const counter = registry.register(new Counter('demo_total', 'Demo counter.', ['route']));
    const histogram = registry.register(new Histogram('demo_seconds', 'Demo latency.', ['route'], [0.1, 1]));
    registry.register(new CollectedGauge('demo_depth', 'Demo depth.', () => [{ labels: { lane: 'a"b' }, value: 3 }]));
    counter.inc({ route: '/v1/x' }, 2);
    histogram.observe({ route: '/v1/x' }, 0.5);

    expect(await registry.render()).toBe([
      '# HELP demo_total Demo counter.',
      '# TYPE demo_total counter',
      'demo_total{route="/v1/x"} 2',
      '# HELP demo_seconds Demo latency.',
      '# TYPE demo_seconds histogram',
      'demo_seconds_bucket{route="/v1/x",le="0.1"} 0',
      'demo_seconds_bucket{route="/v1/x",le="1"} 1',
      'demo_seconds_bucket{route="/v1/x",le="+Inf"} 1',
      'demo_seconds_sum{route="/v1/x"} 0.5',
      'demo_seconds_count{route="/v1/x"} 1',
      '# HELP demo_depth Demo depth.',
      '# TYPE demo_depth gauge',
      'demo_depth{lane="a\\"b"} 3',
      '',
    ].join('\n'));
  });

  it('rejects an undeclared label instead of minting a new series', () => {
    const counter = new Counter('demo_total', 'Demo.', ['route']);
    expect(() => counter.inc({ path: '/x' })).toThrow('metric demo_total has no label(s) path; declared: route');
  });

  it('rejects a duplicate metric name', () => {
    const registry = new MetricsRegistry();
    registry.register(new Counter('demo_total', 'Demo.'));
    expect(() => registry.register(new Counter('demo_total', 'Demo.'))).toThrow('metric demo_total is already registered');
  });
});

describe('metrics listener', () => {
  let listener: http.Server | null = null;
  afterEach(async () => {
    await stopMetricsServer(listener);
    listener = null;
  });

  it('stays off unless CLAUDE_MEM_METRICS_PORT is set and refuses a malformed port', () => {
    expect(resolveMetricsListenerConfig({})).toBeNull();
    expect(resolveMetricsListenerConfig({ CLAUDE_MEM_METRICS_PORT: '9464' })).toEqual({ port: 9464, host: '127.0.0.1' });
    expect(resolveMetricsListenerConfig({ CLAUDE_MEM_METRICS_PORT: '9464', CLAUDE_MEM_METRICS_HOST: '0.0.0.0' }))
      .toEqual({ port: 9464, host: '0.0.0.0' });
    expect(() => resolveMetricsListenerConfig({ CLAUDE_MEM_METRICS_PORT: 'abc' }))
      .toThrow('CLAUDE_MEM_METRICS_PORT must be an integer between 0 and 65535, got "abc"');
  });

  it('serves /metrics with the Prometheus content type and 404s anything else', async () => {
    const registry = new MetricsRegistry();
    registry.register(new Counter('demo_total', 'Demo.')).inc();
    listener = await startMetricsServer(registry, { port: 0, host: '127.0.0.1' });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('listener has no TCP address');
    const base = `http://127.0.0.1:${address.port}`;

    const scrape = await fetch(`${base}/metrics`);
    expect(scrape.status).toBe(200);
    expect(scrape.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);
    expect(await scrape.text()).toContain('demo_total 1');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/v1/memories`)).status).toBe(404);
  });

  it('answers 500 with the cause when a collector fails', async () => {
    const registry = new MetricsRegistry();
    registry.register(new CollectedGauge('demo_depth', 'Demo.', () => { throw new Error('redis down'); }));
    listener = await startMetricsServer(registry, { port: 0, host: '127.0.0.1' });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('listener has no TCP address');

    const scrape = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    expect(scrape.status).toBe(500);
    expect(await scrape.text()).toBe('metrics collection failed: redis down\n');
  });
});

describe('queue metrics', () => {
  it('reports an unreachable lane as up=0 with no job samples', () => {
    const samples = queueSamples([
      lane({ kind: 'event', waiting: 7, active: 1 }),
      lane({ kind: 'summary', unavailable: true, unavailableReason: 'ECONNREFUSED' }),
    ]);
    expect(samples.up).toEqual([
      { labels: { lane: 'event' }, value: 1 },
      { labels: { lane: 'summary' }, value: 0 },
    ]);
    expect(samples.jobs.filter(s => s.labels.lane === 'summary')).toEqual([]);
    expect(samples.jobs).toContainEqual({ labels: { lane: 'event', state: 'waiting' }, value: 7 });
  });

  it('reads Redis once per scrape for both queue gauges', async () => {
    let reads = 0;
    const unregister = registerQueueMetrics(async () => {
      reads += 1;
      return [lane({ waiting: 4 })];
    });
    try {
      const body = await metricsRegistry.render();
      expect(body).toContain('claude_mem_queue_jobs{lane="event",state="waiting"} 4');
      expect(body).toContain('claude_mem_queue_up{lane="event"} 1');
      expect(reads).toBe(1);
    } finally {
      unregister();
    }
  });
});

describe('generation metrics', () => {
  it('classifies failures by the error the generator raised', () => {
    expect(generationFailureReason(new ServerClassifiedProviderError('bad xml', { kind: 'parse_error', cause: undefined })))
      .toBe('parse_error');
    expect(generationFailureReason(new ServerGenerationScopeViolationError('revoked_key', 'revoked'))).toBe('revoked_key');
    expect(generationFailureReason(new Error('boom'))).toBe('unknown');
  });

  it('counts completed and failed attempts per lane', () => {
    const completed = { lane: 'summary', outcome: 'completed', reason: '' };
    const failed = { lane: 'summary', outcome: 'failed', reason: 'rate_limit' };
    const before = { completed: generationAttemptsTotal.get(completed), failed: generationAttemptsTotal.get(failed) };
    const start = { lane: 'summary' as const, startedAt: process.hrtime.bigint(), startUnixNano: 0n, bullmqJobId: '1' };

    recordGenerationAttempt(start);
    recordGenerationAttempt({
      ...start,
      error: new ServerClassifiedProviderError('slow down', { kind: 'rate_limit', cause: undefined }),
    });

    expect(generationAttemptsTotal.get(completed)).toBe(before.completed + 1);
    expect(generationAttemptsTotal.get(failed)).toBe(before.failed + 1);
  });

  it('exposes every lane and failure reason at zero so rate() counts the first failures', async () => {
    initGenerationAttemptSeries();
    const body = await metricsRegistry.render();
    for (const lane of ['event', 'summary']) {
      expect(body).toMatch(new RegExp(`^claude_mem_generation_attempts_total\\{lane="${lane}",outcome="completed",reason=""\\} \\d+$`, 'm'));
      for (const reason of ['transient', 'parse_error', 'scope_mismatch', 'unknown']) {
        expect(body).toMatch(new RegExp(`^claude_mem_generation_attempts_total\\{lane="${lane}",outcome="failed",reason="${reason}"\\} \\d+$`, 'm'));
      }
    }
  });

  it('adds provider tokens and ignores a response that reported none', () => {
    const labels = { provider: 'openrouter', model: 'test-model' };
    const before = providerTokensTotal.get(labels);
    recordProviderTokens({ rawText: '', providerLabel: 'openrouter', modelId: 'test-model', tokensUsed: 120 });
    recordProviderTokens({ rawText: '', providerLabel: 'openrouter', modelId: 'test-model' });
    expect(providerTokensTotal.get(labels)).toBe(before + 120);
  });
});

describe('ServerService HTTP metrics', () => {
  let service: ServerService | null = null;
  afterEach(async () => {
    await service?.stop();
    service = null;
  });

  it('labels requests by route template and folds unmatched paths into one series', async () => {
    service = new ServerService({
      graph: {
        runtime: 'server-beta',
        postgres: {
          pool: new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' }),
          bootstrap: { initialized: true, schemaVersion: 1, appliedAt: new Date(0).toISOString() },
        },
        authMode: 'local-dev',
        queueManager: new DisabledServerQueueManager('test'),
        generationWorkerManager: new DisabledServerGenerationWorkerManager('test'),
      },
      port: 0,
      host: '127.0.0.1',
      persistRuntimeState: false,
    });
    await service.start();
    const base = `http://127.0.0.1:${service.getRuntimeState().port}`;

    await fetch(`${base}/healthz`);
    await fetch(`${base}/no/such/path/${Date.now()}`);
    const body = await metricsRegistry.render();

    expect(body).toMatch(/^claude_mem_http_requests_total\{method="GET",route="\/healthz",status_code="200"\} \d+$/m);
    expect(body).toMatch(/^claude_mem_http_requests_total\{method="GET",route="unmatched",status_code="404"\} \d+$/m);
    expect(body).not.toContain('/no/such/path');
    expect(body).toContain('claude_mem_build_info{version=');
  });
});
