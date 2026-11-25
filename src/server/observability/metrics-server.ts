// SPDX-License-Identifier: Apache-2.0

import http from 'http';
import { logger } from '../../utils/logger.js';
import type { MetricsRegistry } from './metrics-registry.js';

const DEFAULT_METRICS_HOST = '127.0.0.1';
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface MetricsListenerConfig {
  port: number;
  host: string;
}

// Unset CLAUDE_MEM_METRICS_PORT keeps local installs free of an extra listener.
export function resolveMetricsListenerConfig(env: NodeJS.ProcessEnv = process.env): MetricsListenerConfig | null {
  const raw = env.CLAUDE_MEM_METRICS_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CLAUDE_MEM_METRICS_PORT must be an integer between 0 and 65535, got "${raw}"`);
  }
  return { port, host: env.CLAUDE_MEM_METRICS_HOST?.trim() || DEFAULT_METRICS_HOST };
}

export async function startMetricsServer(
  registry: MetricsRegistry,
  config: MetricsListenerConfig,
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' || (path !== '/metrics' && path !== '/healthz')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found\n');
      return;
    }
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
      return;
    }
    registry.render().then(
      body => res.writeHead(200, { 'Content-Type': METRICS_CONTENT_TYPE }).end(body),
      (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('SYSTEM', 'metrics scrape failed', {}, err);
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`metrics collection failed: ${err.message}\n`);
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  logger.info('SYSTEM', 'metrics listener started', {
    host: config.host,
    port: address && typeof address !== 'string' ? address.port : config.port,
  });
  return server;
}

export async function stopMetricsServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
