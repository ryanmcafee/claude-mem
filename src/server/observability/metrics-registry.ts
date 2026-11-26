// SPDX-License-Identifier: Apache-2.0
//
// Minimal Prometheus text-exposition (format 0.0.4) registry. Hand-rolled so the
// server bundle gains no runtime dependency; covers counters, gauges and histograms.

export type Labels = Readonly<Record<string, string>>;

interface Metric {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'gauge' | 'histogram';
  render(): Promise<string[]> | string[];
}

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function seriesKey(labelNames: readonly string[], labels: Labels): string {
  return JSON.stringify(labelNames.map(name => labels[name] ?? ''));
}

function pickLabels(name: string, labelNames: readonly string[], labels: Labels): Labels {
  const unknown = Object.keys(labels).filter(key => !labelNames.includes(key));
  if (unknown.length > 0) {
    throw new Error(`metric ${name} has no label(s) ${unknown.join(', ')}; declared: ${labelNames.join(', ') || 'none'}`);
  }
  return Object.fromEntries(labelNames.map(key => [key, labels[key] ?? '']));
}

export class Counter implements Metric {
  readonly type = 'counter' as const;
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(readonly name: string, readonly help: string, private readonly labelNames: readonly string[] = []) {}

  inc(labels: Labels = {}, amount = 1): void {
    if (amount < 0 || !Number.isFinite(amount)) {
      throw new Error(`counter ${this.name} can only increase by a finite non-negative amount, got ${amount}`);
    }
    const picked = pickLabels(this.name, this.labelNames, labels);
    const key = seriesKey(this.labelNames, picked);
    const current = this.series.get(key);
    if (current) current.value += amount;
    else this.series.set(key, { labels: picked, value: amount });
  }

  get(labels: Labels = {}): number {
    return this.series.get(seriesKey(this.labelNames, labels))?.value ?? 0;
  }

  render(): string[] {
    return [...this.series.values()].map(s => `${this.name}${formatLabels(s.labels)} ${formatValue(s.value)}`);
  }
}

export type GaugeSample = { labels: Labels; value: number };

// A gauge whose samples are produced at scrape time by the collect callback.
export class CollectedGauge implements Metric {
  readonly type = 'gauge' as const;

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly collect: () => Promise<GaugeSample[]> | GaugeSample[],
  ) {}

  async render(): Promise<string[]> {
    const samples = await this.collect();
    return samples.map(s => `${this.name}${formatLabels(s.labels)} ${formatValue(s.value)}`);
  }
}

export class Histogram implements Metric {
  readonly type = 'histogram' as const;
  private readonly buckets: readonly number[];
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[],
    buckets: readonly number[],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    const picked = pickLabels(this.name, this.labelNames, labels);
    const key = seriesKey(this.labelNames, picked);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels: picked, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    this.buckets.forEach((bound, i) => {
      if (value <= bound) entry.counts[i] += 1;
    });
    entry.sum += value;
    entry.count += 1;
  }

  render(): string[] {
    return [...this.series.values()].flatMap(s => [
      ...this.buckets.map((bound, i) =>
        `${this.name}_bucket${formatLabels({ ...s.labels, le: formatValue(bound) })} ${s.counts[i]}`),
      `${this.name}_bucket${formatLabels({ ...s.labels, le: '+Inf' })} ${s.count}`,
      `${this.name}_sum${formatLabels(s.labels)} ${formatValue(s.sum)}`,
      `${this.name}_count${formatLabels(s.labels)} ${s.count}`,
    ]);
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  register<T extends Metric>(metric: T): T {
    if (!NAME_PATTERN.test(metric.name)) {
      throw new Error(`invalid metric name ${metric.name}`);
    }
    if (this.metrics.has(metric.name)) {
      throw new Error(`metric ${metric.name} is already registered`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  unregister(name: string): void {
    this.metrics.delete(name);
  }

  async render(): Promise<string> {
    const blocks = await Promise.all([...this.metrics.values()].map(async metric => [
      `# HELP ${metric.name} ${metric.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`,
      `# TYPE ${metric.name} ${metric.type}`,
      ...(await metric.render()),
    ].join('\n')));
    return `${blocks.join('\n')}\n`;
  }
}
