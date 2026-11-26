// SPDX-License-Identifier: Apache-2.0

import type { ServerQueueLaneMetric } from '../runtime/types.js';
import { resolveMetricsListenerConfig, startMetricsServer, stopMetricsServer } from './metrics-server.js';
import { startTracerFromEnv, stopTracer } from './otlp-tracer.js';
import { metricsRegistry, registerQueueMetrics, setMetricsComponent, type MetricsComponent } from './server-metrics.js';

export interface ObservabilityOptions {
  component: MetricsComponent;
  readQueueLanes?: () => Promise<ServerQueueLaneMetric[]>;
  env?: NodeJS.ProcessEnv;
}

export type StopObservability = () => Promise<void>;

export async function startObservability(options: ObservabilityOptions): Promise<StopObservability> {
  const env = options.env ?? process.env;
  const listenerConfig = resolveMetricsListenerConfig(env);
  setMetricsComponent(options.component);
  startTracerFromEnv(`claude-mem-${options.component}`, env);
  const unregisterQueue = options.readQueueLanes ? registerQueueMetrics(options.readQueueLanes) : () => {};
  try {
    const listener = listenerConfig ? await startMetricsServer(metricsRegistry, listenerConfig) : null;
    return async () => {
      unregisterQueue();
      await Promise.all([stopMetricsServer(listener), stopTracer()]);
    };
  } catch (error) {
    unregisterQueue();
    await stopTracer();
    throw error;
  }
}
