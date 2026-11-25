import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import http from 'http';
import {
  OtlpTracer,
  parseOtlpHeaders,
  parseTraceparent,
  resolveOtlpTracerConfig,
} from '../../../src/server/observability/otlp-tracer.js';
import { logger } from '../../../src/utils/logger.js';

interface Received {
  headers: http.IncomingHttpHeaders;
  body: {
    resourceSpans: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
      scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
    }>;
  };
}

function startCollector(status = 200): Promise<{ url: string; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(status).end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('collector has no TCP address');
    resolve({
      url: `http://127.0.0.1:${address.port}/v1/traces`,
      received,
      close: () => new Promise(done => server.close(() => done())),
    });
  }));
}

const warnings: string[] = [];
const loggerSpies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  loggerSpies.push(spyOn(logger, 'info').mockImplementation(() => {}));
  loggerSpies.push(spyOn(logger, 'warn').mockImplementation((_component, message) => { warnings.push(message); }));
});
afterEach(() => {
  loggerSpies.splice(0).forEach(spy => spy.mockRestore());
  warnings.splice(0);
});

describe('OTLP configuration', () => {
  it('stays off without an endpoint or when the SDK is disabled', () => {
    expect(resolveOtlpTracerConfig('claude-mem-server', {})).toBeNull();
    expect(resolveOtlpTracerConfig('claude-mem-server', {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
      OTEL_SDK_DISABLED: 'true',
    })).toBeNull();
  });

  it('derives the traces path from the base endpoint and merges headers', () => {
    expect(resolveOtlpTracerConfig('claude-mem-worker', {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318/',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20abc,x-team=a',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-team=b',
    })).toEqual({
      endpoint: 'http://otel:4318/v1/traces',
      headers: { authorization: 'Bearer abc', 'x-team': 'b' },
      serviceName: 'claude-mem-worker',
    });
  });

  it('refuses a protocol it cannot speak instead of exporting nothing', () => {
    expect(() => resolveOtlpTracerConfig('claude-mem-server', {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4317',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    })).toThrow('OTEL_EXPORTER_OTLP_PROTOCOL=grpc is not supported; claude-mem exports traces as http/json only');
  });

  it('parses W3C traceparent and rejects all-zero ids', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'))
      .toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' });
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseOtlpHeaders('novalue,=x')).toEqual({});
  });
});

describe('OtlpTracer export', () => {
  it('posts batched spans as OTLP/HTTP JSON to a real collector', async () => {
    const collector = await startCollector();
    try {
      const tracer = new OtlpTracer({ endpoint: collector.url, headers: { authorization: 'Bearer t' }, serviceName: 'claude-mem-server' });
      tracer.record({
        name: 'GET /healthz',
        kind: 'server',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        parentSpanId: '1111111111111111',
        startUnixNano: 1_000n,
        endUnixNano: 2_000n,
        attributes: { 'http.response.status_code': 503, 'http.route': '/healthz' },
        error: 'HTTP 503',
      });
      await tracer.shutdown();

      expect(collector.received).toHaveLength(1);
      const [request] = collector.received;
      expect(request.headers.authorization).toBe('Bearer t');
      expect(request.headers['content-type']).toBe('application/json');
      const resourceSpans = request.body.resourceSpans[0];
      expect(resourceSpans.resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'claude-mem-server' } }]);
      expect(resourceSpans.scopeSpans[0].spans).toEqual([{
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        parentSpanId: '1111111111111111',
        name: 'GET /healthz',
        kind: 2,
        startTimeUnixNano: '1000',
        endTimeUnixNano: '2000',
        attributes: [
          { key: 'http.response.status_code', value: { intValue: '503' } },
          { key: 'http.route', value: { stringValue: '/healthz' } },
        ],
        status: { code: 2, message: 'HTTP 503' },
      }]);
    } finally {
      await collector.close();
    }
  });

  it('logs and drops a batch the collector rejects without throwing', async () => {
    const collector = await startCollector(503);
    try {
      const tracer = new OtlpTracer({ endpoint: collector.url, headers: {}, serviceName: 'claude-mem-worker' });
      tracer.record({
        name: 'generation event', kind: 'consumer', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
        startUnixNano: 1n, endUnixNano: 2n, attributes: {},
      });
      await tracer.shutdown();
      expect(warnings).toEqual(['OTLP trace export failed; batch dropped']);
    } finally {
      await collector.close();
    }
  });
});
