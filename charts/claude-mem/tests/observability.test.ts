// SPDX-License-Identifier: Apache-2.0
//
// Rendered-manifest gates for metrics, alerting, dashboard and tracing. Requires helm and
// promtool on PATH (or HELM_BIN / PROMTOOL_BIN); the chart workflow installs pinned versions.

import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { copyFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { metricsRegistry, registerQueueMetrics } from '../../../src/server/observability/server-metrics.js';

setDefaultTimeout(30_000);

const chartDir = join(import.meta.dir, '..');
const helmBin = process.env.HELM_BIN ?? 'helm';
const promtoolBin = process.env.PROMTOOL_BIN ?? 'promtool';
const REQUIRED = ['database.existingSecret=pg-app', 'redis.url=redis://valkey:6379'];
const ALL_ON = ['metrics.serviceMonitor.enabled=true', 'metrics.prometheusRule.enabled=true', 'metrics.dashboard.enabled=true'];

interface EnvVar { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }
interface Port { name: string; port?: number; containerPort?: number }
interface Container { name: string; env?: EnvVar[]; ports?: Port[] }
interface Manifest {
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  data?: Record<string, string>;
  spec?: {
    ports?: Port[];
    ingress?: Array<{ ports?: Array<{ port: string }>; from?: unknown[] }>;
    selector?: { matchLabels?: Record<string, string>; matchExpressions?: Array<{ key: string; values: string[] }> };
    endpoints?: Array<{ port: string; path: string }>;
    groups?: Array<{ name: string; rules: Array<{ alert: string; expr: string; annotations: Record<string, string> }> }>;
    template?: { spec: { containers: Container[] } };
  };
}

function run(bin: string, args: string[], cwd = chartDir): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync([bin, ...args], { cwd });
  if (result.exitCode === null) throw new Error(`${bin} ${args[0]} was killed by ${result.signalCode ?? 'an unknown signal'}`);
  return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function render(sets: string[] = [], namespace = 'memory'): Manifest[] {
  const { ok, stdout, stderr } = run(helmBin, ['template', 'mem', '.', '-n', namespace, ...[...REQUIRED, ...sets].flatMap(s => ['--set', s])]);
  if (!ok) throw new Error(`helm template failed: ${stderr}`);
  return stdout.split(/^---\s*$/m)
    .map(doc => Bun.YAML.parse(doc))
    .filter((doc): doc is Manifest => typeof doc === 'object' && doc !== null && 'kind' in doc);
}

function renderError(sets: string[]): string {
  const { ok, stderr } = run(helmBin, ['template', 'mem', '.', ...[...REQUIRED, ...sets].flatMap(s => ['--set', s])]);
  expect(ok).toBe(false);
  return stderr;
}

const find = (manifests: Manifest[], kind: string, name: string): Manifest => {
  const found = manifests.find(m => m.kind === kind && m.metadata.name === name);
  if (!found) throw new Error(`${kind}/${name} not rendered`);
  return found;
};

const container = (manifests: Manifest[], deployment: string): Container => {
  const first = find(manifests, 'Deployment', deployment).spec?.template?.spec.containers[0];
  if (!first) throw new Error(`Deployment/${deployment} has no container`);
  return first;
};

const envOf = (c: Container) => Object.fromEntries((c.env ?? []).map(e => [e.name, e.value ?? e.valueFrom]));

async function emittedMetricNames(): Promise<Set<string>> {
  const unregister = registerQueueMetrics(async () => []);
  try {
    const body = await metricsRegistry.render();
    const names = [...body.matchAll(/^# TYPE (\S+) (\S+)$/gm)].flatMap(([, name, type]) =>
      type === 'histogram' ? [`${name}_bucket`, `${name}_sum`, `${name}_count`] : [name]);
    return new Set([...names, 'up']);
  } finally {
    unregister();
  }
}

const referencedMetrics = (expr: string) =>
  [...expr.matchAll(/\b(claude_mem_[a-z_]+|process_[a-z_]+|up)\s*\{/g)].map(([, name]) => name);

describe('metrics listener', () => {
  it('serves metrics from server and worker on their own port by default, and only from them', () => {
    const manifests = render();
    for (const name of ['mem-claude-mem-server', 'mem-claude-mem-worker']) {
      const c = container(manifests, name);
      expect(envOf(c)).toMatchObject({ CLAUDE_MEM_METRICS_PORT: '9464', CLAUDE_MEM_METRICS_HOST: '0.0.0.0' });
      expect(c.ports).toContainEqual({ name: 'metrics', containerPort: 9464, protocol: 'TCP' });
    }
    const migrate = manifests.find(m => m.kind === 'Job');
    expect(JSON.stringify(migrate)).not.toContain('CLAUDE_MEM_METRICS_PORT');
    expect(find(manifests, 'Service', 'mem-claude-mem').spec?.ports?.map(p => p.name)).toEqual(['http', 'metrics']);
    expect(find(manifests, 'Service', 'mem-claude-mem-worker-metrics').spec?.ports?.map(p => p.name)).toEqual(['metrics']);
  });

  it('keeps the metrics port out of ingress and HTTPRoute backends', () => {
    const manifests = render([
      'ingress.enabled=true', 'ingress.hosts[0].host=memory.example.test', 'ingress.hosts[0].paths[0].path=/',
      'ingress.hosts[0].paths[0].pathType=Prefix',
    ]);
    expect(JSON.stringify(find(manifests, 'Ingress', 'mem-claude-mem'))).not.toContain('9464');
  });

  it('opens the metrics port, and only it, to the configured scraper on both network policies', () => {
    const manifests = render(['metrics.allowedNamespaceLabels.kubernetes\\.io/metadata\\.name=monitoring']);
    for (const name of ['mem-claude-mem-server', 'mem-claude-mem-worker']) {
      const rule = find(manifests, 'NetworkPolicy', name).spec?.ingress?.find(r => r.ports?.[0]?.port === 'metrics');
      expect(rule?.from).toEqual([{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'monitoring' } } }]);
    }
  });

  it('renders no listener, port or metrics Service when disabled', () => {
    const manifests = render(['metrics.enabled=false']);
    expect(envOf(container(manifests, 'mem-claude-mem-worker')).CLAUDE_MEM_METRICS_PORT).toBeUndefined();
    expect(manifests.some(m => m.metadata.name === 'mem-claude-mem-worker-metrics')).toBe(false);
    expect(renderError(['metrics.enabled=false', 'metrics.serviceMonitor.enabled=true']))
      .toContain('metrics.serviceMonitor, metrics.prometheusRule and metrics.dashboard need metrics.enabled=true');
  });
});

describe('Prometheus Operator resources', () => {
  it('ships ServiceMonitor, PrometheusRule and dashboard off by default', () => {
    const kinds = render().map(m => m.kind);
    expect(kinds).not.toContain('ServiceMonitor');
    expect(kinds).not.toContain('PrometheusRule');
    expect(render().some(m => m.metadata.name === 'mem-claude-mem-dashboard')).toBe(false);
  });

  it('scrapes the server and worker metrics Services and nothing else', () => {
    const manifests = render(ALL_ON);
    const monitor = find(manifests, 'ServiceMonitor', 'mem-claude-mem');
    expect(monitor.spec?.endpoints).toEqual([{ port: 'metrics', path: '/metrics', interval: '30s', scrapeTimeout: '10s' }]);
    const selected = manifests.filter(m => m.kind === 'Service'
      && Object.entries(monitor.spec?.selector?.matchLabels ?? {}).every(([k, v]) => m.metadata.labels?.[k] === v)
      && (monitor.spec?.selector?.matchExpressions ?? []).every(e => e.values.includes(m.metadata.labels?.[e.key] ?? '')));
    expect(selected.map(m => m.metadata.name).sort()).toEqual(['mem-claude-mem', 'mem-claude-mem-worker-metrics']);
  });

  it('alerts and dashboard panels query only metrics this build emits', async () => {
    const emitted = await emittedMetricNames();
    const manifests = render(ALL_ON);
    const rules = find(manifests, 'PrometheusRule', 'mem-claude-mem').spec?.groups?.flatMap(g => g.rules) ?? [];
    const dashboard = JSON.parse(find(manifests, 'ConfigMap', 'mem-claude-mem-dashboard').data?.['claude-mem.json'] ?? '{}');
    const panelExprs: string[] = dashboard.panels.flatMap((p: { targets?: Array<{ expr: string }> }) => (p.targets ?? []).map(t => t.expr));
    const exprs = [...rules.map(r => r.expr), ...panelExprs];
    const referenced = exprs.flatMap(referencedMetrics);

    expect(rules.map(r => r.alert)).toEqual([
      'ClaudeMemServerDown', 'ClaudeMemQueueBacklogGrowing', 'ClaudeMemGenerationFailureRatio', 'ClaudeMemHttpErrorRatio',
    ]);
    expect(panelExprs.length).toBeGreaterThanOrEqual(14);
    expect(new Set(referenced)).toContain('claude_mem_provider_tokens_total');
    expect(referenced.filter(name => !emitted.has(name))).toEqual([]);
  });

  it('gives every alert a runbook link and actionable description', () => {
    const rules = find(render(ALL_ON), 'PrometheusRule', 'mem-claude-mem').spec?.groups?.flatMap(g => g.rules) ?? [];
    for (const rule of rules) {
      expect(rule.annotations.runbook_url).toBe(
        `https://github.com/ryanmcafee/claude-mem/blob/main/charts/claude-mem/RUNBOOK.md#${rule.alert.toLowerCase()}`);
      expect(rule.annotations.description).toMatch(/kubectl|helm|sum by/);
    }
  });

  it('fires and stays quiet on the promtool fixtures', () => {
    const groups = find(render(['metrics.prometheusRule.enabled=true']), 'PrometheusRule', 'mem-claude-mem').spec?.groups;
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-rules-'));
    writeFileSync(join(dir, 'rules.yaml'), JSON.stringify({ groups }));
    copyFileSync(join(import.meta.dir, 'alerts.promtool.yaml'), join(dir, 'alerts.promtool.yaml'));
    const result = run(promtoolBin, ['test', 'rules', 'alerts.promtool.yaml'], dir);
    expect(`${result.stdout}${result.stderr}`).toContain('SUCCESS');
    expect(result.ok).toBe(true);
  });

  it('places the dashboard where the Grafana sidecar looks', () => {
    const cm = find(render(['metrics.dashboard.enabled=true', 'metrics.dashboard.namespace=monitoring']), 'ConfigMap', 'mem-claude-mem-dashboard');
    expect(cm.metadata.namespace).toBe('monitoring');
    expect(cm.metadata.labels?.grafana_dashboard).toBe('1');
  });
});

describe('tracing', () => {
  it('exports to the configured collector from server and worker only', () => {
    const manifests = render([
      'tracing.otlp.enabled=true', 'tracing.otlp.endpoint=http://otel.observability:4318',
      'tracing.otlp.headersSecret.name=otel-auth',
    ]);
    for (const name of ['mem-claude-mem-server', 'mem-claude-mem-worker']) {
      expect(envOf(container(manifests, name))).toMatchObject({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.observability:4318',
        OTEL_EXPORTER_OTLP_HEADERS: { secretKeyRef: { name: 'otel-auth', key: 'headers' } },
      });
    }
    expect(JSON.stringify(manifests.find(m => m.kind === 'Job'))).not.toContain('OTEL_EXPORTER');
  });

  it('is off by default and refuses to enable without an endpoint', () => {
    expect(JSON.stringify(render())).not.toContain('OTEL_EXPORTER');
    expect(renderError(['tracing.otlp.enabled=true'])).toContain('tracing.otlp.endpoint is required');
  });
});
