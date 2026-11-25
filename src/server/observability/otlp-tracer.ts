// SPDX-License-Identifier: Apache-2.0
//
// Minimal OTLP/HTTP JSON span exporter, configured by the standard OTEL_* env vars.
// Off unless an OTLP endpoint is set; spans are batched and dropped (never blocking) when the collector is slow.

import { randomBytes } from 'crypto';
import { logger } from '../../utils/logger.js';

export type SpanKind = 'internal' | 'server' | 'consumer';
export type SpanAttributes = Record<string, string | number | boolean>;

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface FinishedSpan {
  name: string;
  kind: SpanKind;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startUnixNano: bigint;
  endUnixNano: bigint;
  attributes: SpanAttributes;
  error?: string;
}

export interface OtlpTracerConfig {
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

const SPAN_KIND_CODES: Record<SpanKind, number> = { internal: 1, server: 2, consumer: 5 };
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function parseTraceparent(header: string | undefined): SpanContext | null {
  const match = header?.trim().toLowerCase().match(TRACEPARENT);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], spanId: match[2] };
}

export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(raw.split(',').flatMap(pair => {
    const index = pair.indexOf('=');
    if (index <= 0) return [];
    return [[decodeURIComponent(pair.slice(0, index).trim()), decodeURIComponent(pair.slice(index + 1).trim())]];
  }));
}

export function resolveOtlpTracerConfig(
  defaultServiceName: string,
  env: NodeJS.ProcessEnv = process.env,
): OtlpTracerConfig | null {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return null;
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const endpoint = tracesEndpoint || (baseEndpoint ? `${baseEndpoint.replace(/\/+$/, '')}/v1/traces` : '');
  if (!endpoint) return null;
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/json').trim();
  if (protocol !== 'http/json') {
    throw new Error(`OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is not supported; claude-mem exports traces as http/json only`);
  }
  return {
    endpoint,
    headers: { ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) },
    serviceName: env.OTEL_SERVICE_NAME?.trim() || defaultServiceName,
  };
}

export const newTraceId = (): string => randomBytes(16).toString('hex');
export const newSpanId = (): string => randomBytes(8).toString('hex');
export const nowUnixNano = (): bigint => BigInt(Date.now()) * 1_000_000n;

const toAttribute = ([key, value]: [string, string | number | boolean]) => ({
  key,
  value: typeof value === 'string' ? { stringValue: value }
    : typeof value === 'boolean' ? { boolValue: value }
    : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
});

export function toOtlpPayload(serviceName: string, spans: readonly FinishedSpan[]): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: [toAttribute(['service.name', serviceName])] },
      scopeSpans: [{
        scope: { name: 'claude-mem' },
        spans: spans.map(span => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: SPAN_KIND_CODES[span.kind],
          startTimeUnixNano: span.startUnixNano.toString(),
          endTimeUnixNano: span.endUnixNano.toString(),
          attributes: Object.entries(span.attributes).map(toAttribute),
          status: span.error ? { code: 2, message: span.error } : { code: 1 },
        })),
      }],
    }],
  };
}

export class OtlpTracer {
  private queue: FinishedSpan[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> = Promise.resolve();

  constructor(private readonly config: OtlpTracerConfig, private readonly fetchImpl: FetchLike = fetch) {}

  start(): void {
    this.timer ??= setInterval(() => { void this.flush(); }, this.config.flushIntervalMs ?? 5_000);
    this.timer.unref?.();
    logger.info('SYSTEM', 'OTLP trace export enabled', { endpoint: this.config.endpoint, serviceName: this.config.serviceName });
  }

  record(span: FinishedSpan): void {
    if (this.queue.length >= (this.config.maxQueue ?? 2_048)) {
      this.dropped += 1;
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= (this.config.maxBatch ?? 512)) void this.flush();
  }

  flush(): Promise<void> {
    this.inflight = this.inflight.then(() => this.exportBatch());
    return this.inflight;
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  private async exportBatch(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.config.maxBatch ?? 512);
    const dropped = this.dropped;
    this.dropped = 0;
    try {
      const response = await this.fetchImpl(this.config.endpoint, {
        method: 'POST',
        headers: { ...this.config.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(toOtlpPayload(this.config.serviceName, batch)),
      });
      if (!response.ok) throw new Error(`collector answered HTTP ${response.status}`);
    } catch (error) {
      logger.warn('SYSTEM', 'OTLP trace export failed; batch dropped', {
        endpoint: this.config.endpoint,
        spans: batch.length,
        droppedWhileQueueFull: dropped,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let activeTracer: OtlpTracer | null = null;

export function getTracer(): OtlpTracer | null {
  return activeTracer;
}

export function startTracerFromEnv(defaultServiceName: string, env: NodeJS.ProcessEnv = process.env): OtlpTracer | null {
  const config = resolveOtlpTracerConfig(defaultServiceName, env);
  if (!config) return null;
  activeTracer = new OtlpTracer(config);
  activeTracer.start();
  return activeTracer;
}

export async function stopTracer(): Promise<void> {
  const tracer = activeTracer;
  activeTracer = null;
  await tracer?.shutdown();
}
