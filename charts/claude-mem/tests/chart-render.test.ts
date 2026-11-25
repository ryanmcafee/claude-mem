// SPDX-License-Identifier: Apache-2.0
//
// Asserts on `helm template` output, never on the README. Requires helm on PATH
// (or HELM_BIN); the chart workflow installs a pinned version.

import { describe, expect, it } from 'bun:test';
import { join } from 'path';

const chartDir = join(import.meta.dir, '..');
const helmBin = process.env.HELM_BIN ?? 'helm';

const REQUIRED = ['database.existingSecret=pg-app', 'redis.url=redis://valkey:6379'];
const METERED_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_MEM_OPENROUTER_API_KEY', 'CLAUDE_MEM_ANTHROPIC_API_KEY'];

interface EnvVar { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }
interface Container { name: string; args?: string[]; env?: EnvVar[]; securityContext?: Record<string, unknown> }
interface PodSpec { containers: Container[]; initContainers?: Container[]; securityContext?: Record<string, unknown> }
interface Manifest {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: { template?: { metadata?: { annotations?: Record<string, unknown> }; spec: PodSpec } } & Partial<PodSpec>;
}

function helm(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync([helmBin, ...args], { cwd: chartDir });
  if (result.exitCode === null) {
    throw new Error(`could not run ${helmBin}; install helm or set HELM_BIN`);
  }
  return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function render(sets: string[] = [], extra: string[] = []): { text: string; manifests: Manifest[] } {
  const args = ['template', 'mem', '.', ...[...REQUIRED, ...sets].flatMap(s => ['--set', s]), ...extra];
  const { ok, stdout, stderr } = helm(args);
  if (!ok) throw new Error(`helm template failed: ${stderr}`);
  const manifests = stdout
    .split(/^---\s*$/m)
    .map(doc => Bun.YAML.parse(doc))
    .filter((doc): doc is Manifest => typeof doc === 'object' && doc !== null && 'kind' in doc);
  return { text: stdout, manifests };
}

function renderError(sets: string[], extra: string[] = []): string {
  const { ok, stderr } = helm(['template', 'mem', '.', ...sets.flatMap(s => ['--set', s]), ...extra]);
  expect(ok).toBe(false);
  return stderr;
}

function podSpec(manifests: Manifest[], kind: string, name: string): PodSpec {
  const found = manifests.find(m => m.kind === kind && m.metadata.name === name);
  if (!found) throw new Error(`${kind}/${name} not rendered`);
  const spec = found.spec?.template?.spec ?? found.spec;
  if (!spec?.containers) throw new Error(`${kind}/${name} has no pod spec`);
  return { containers: spec.containers, initContainers: spec.initContainers, securityContext: spec.securityContext };
}

const allContainers = (spec: PodSpec) => [...spec.containers, ...(spec.initContainers ?? [])];
const envNames = (spec: PodSpec) => allContainers(spec).flatMap(c => (c.env ?? []).map(e => e.name));

describe('auth gate', () => {
  it('refuses local-dev through the schema', () => {
    expect(renderError([...REQUIRED, 'auth.mode=local-dev'])).toMatch(/auth\/mode/);
  });

  it('refuses local-dev in the template even when schema validation is skipped', () => {
    expect(renderError([...REQUIRED, 'auth.mode=local-dev'], ['--skip-schema-validation'])).toMatch(/only deploys CLAUDE_MEM_AUTH_MODE=api-key/);
  });

  it('sets api-key auth on every workload', () => {
    const { manifests } = render();
    for (const name of ['mem-claude-mem-server', 'mem-claude-mem-worker']) {
      const env = allContainers(podSpec(manifests, 'Deployment', name)).flatMap(c => c.env ?? []);
      expect(env.find(e => e.name === 'CLAUDE_MEM_AUTH_MODE')?.value).toBe('api-key');
    }
  });
});

describe('shared-scope gate (MCAA-286)', () => {
  const sets = ['auth.apiKeys.existingSecret=agent-keys', 'tests.apiKeyName=ci'];

  it('mints no shared-publish or wildcard scope with default values', () => {
    const { text, manifests } = render(sets);
    expect(text).not.toContain('memories:write:shared');
    const args = manifests.flatMap(m => (m.spec?.template?.spec ? allContainers(m.spec.template.spec) : [])).flatMap(c => c.args ?? []);
    expect(args.some(a => a.includes('*'))).toBe(false);
    expect(args.some(a => a.startsWith('--scope'))).toBe(false);
  });

  it('leaves CLAUDE_MEM_INCLUDE_SHARED absent', () => {
    expect(render(sets).text).not.toContain('CLAUDE_MEM_INCLUDE_SHARED');
  });

  it('refuses CLAUDE_MEM_INCLUDE_SHARED through extraEnv', () => {
    expect(renderError([...REQUIRED, 'worker.extraEnv[0].name=CLAUDE_MEM_INCLUDE_SHARED', 'worker.extraEnv[0].value=true'])).toMatch(/CLAUDE_MEM_INCLUDE_SHARED/);
  });
});

describe('generation credentials', () => {
  it('puts no metered API key in any pod with default values', () => {
    const { manifests } = render(['generation.existingSecret=llm']);
    const worker = podSpec(manifests, 'Deployment', 'mem-claude-mem-worker');
    for (const name of METERED_ENV) expect(envNames(worker)).not.toContain(name);
    expect(envNames(worker)).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(envNames(worker)).not.toContain('CLAUDE_MEM_SERVER_PROVIDER');
  });

  it('keeps every provider credential off the server and migration pods', () => {
    const { manifests } = render(['generation.existingSecret=llm', 'generation.anthropicApiKey.enabled=true', 'generation.openaiApiKey.enabled=true']);
    for (const spec of [podSpec(manifests, 'Deployment', 'mem-claude-mem-server'), podSpec(manifests, 'Job', 'mem-claude-mem-migrate')]) {
      for (const name of [...METERED_ENV, 'CLAUDE_CODE_OAUTH_TOKEN']) expect(envNames(spec)).not.toContain(name);
    }
  });

  it('refuses a metered provider whose key toggle is off', () => {
    expect(renderError([...REQUIRED, 'generation.existingSecret=llm', 'generation.provider=anthropic'])).toMatch(/anthropicApiKey.enabled=true/);
    expect(renderError([...REQUIRED, 'generation.existingSecret=llm', 'generation.provider=openai'])).toMatch(/openaiApiKey.enabled=true/);
  });

  it('routes openai through the configured OpenAI-compatible base URL', () => {
    const { manifests } = render([
      'generation.existingSecret=llm',
      'generation.provider=openai',
      'generation.openaiApiKey.enabled=true',
      'generation.openaiBaseUrl=http://litellm.litellm.svc:4000/v1',
    ]);
    const env = allContainers(podSpec(manifests, 'Deployment', 'mem-claude-mem-worker')).flatMap(c => c.env ?? []);
    expect(env.find(e => e.name === 'CLAUDE_MEM_SERVER_PROVIDER')?.value).toBe('openrouter');
    expect(env.find(e => e.name === 'CLAUDE_MEM_OPENROUTER_BASE_URL')?.value).toBe('http://litellm.litellm.svc:4000/v1');
    expect(env.find(e => e.name === 'CLAUDE_MEM_OPENROUTER_API_KEY')?.valueFrom?.secretKeyRef).toEqual({ name: 'llm', key: 'OPENAI_API_KEY' });
  });
});

describe('migrations', () => {
  it('runs migrate once as a pre-install/pre-upgrade and ArgoCD PreSync hook', () => {
    const { manifests } = render();
    const jobs = manifests.filter(m => m.kind === 'Job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].metadata.annotations).toMatchObject({
      'helm.sh/hook': 'pre-install,pre-upgrade',
      'argocd.argoproj.io/hook': 'PreSync',
    });
    expect(podSpec(manifests, 'Job', 'mem-claude-mem-migrate').containers[0].args).toEqual([
      'bun', '/opt/claude-mem/scripts/server-service.cjs', 'server', 'migrate',
    ]);
  });

  it('never lets server or worker pods apply the schema', () => {
    const { manifests } = render();
    for (const name of ['mem-claude-mem-server', 'mem-claude-mem-worker']) {
      const env = allContainers(podSpec(manifests, 'Deployment', name)).flatMap(c => c.env ?? []);
      expect(env.find(e => e.name === 'CLAUDE_MEM_SERVER_SCHEMA_BOOTSTRAP')?.value).toBe('false');
    }
  });

  it('imports keys only after migrate succeeds', () => {
    const job = podSpec(render(['auth.apiKeys.existingSecret=agent-keys']).manifests, 'Job', 'mem-claude-mem-migrate');
    expect(job.initContainers?.map(c => c.name)).toEqual(['migrate']);
    expect(job.containers.map(c => c.name)).toEqual(['import-api-keys']);
  });
});

describe('database contract', () => {
  it('reads the CloudNativePG uri key by default', () => {
    const env = allContainers(podSpec(render().manifests, 'Deployment', 'mem-claude-mem-server')).flatMap(c => c.env ?? []);
    expect(env.find(e => e.name === 'CLAUDE_MEM_SERVER_DATABASE_URL')?.valueFrom?.secretKeyRef).toEqual({ name: 'pg-app', key: 'uri' });
  });

  it('builds a credential-free URL and passes username/password as PGUSER/PGPASSWORD', () => {
    const env = allContainers(podSpec(render(['database.mode=credentials']).manifests, 'Deployment', 'mem-claude-mem-server')).flatMap(c => c.env ?? []);
    expect(env.find(e => e.name === 'CLAUDE_MEM_SERVER_DATABASE_URL')?.value).toBe('postgresql://$(CLAUDE_MEM_PGHOST):$(CLAUDE_MEM_PGPORT)/$(CLAUDE_MEM_PGDATABASE)');
    expect(env.find(e => e.name === 'PGUSER')?.valueFrom?.secretKeyRef).toEqual({ name: 'pg-app', key: 'username' });
    expect(env.find(e => e.name === 'PGPASSWORD')?.valueFrom?.secretKeyRef).toEqual({ name: 'pg-app', key: 'password' });
  });

  it('refuses a redis URL with embedded credentials', () => {
    expect(renderError(['database.existingSecret=pg-app', 'redis.url=redis://:hunter2@valkey:6379'])).toMatch(/redis.existingSecret/);
  });
});

describe('hardening', () => {
  it('runs every container non-root on a read-only root filesystem with no capabilities', () => {
    const { manifests } = render(['auth.apiKeys.existingSecret=agent-keys', 'tests.apiKeyName=ci', 'valkey.enabled=true', 'redis.url=']);
    const pods = manifests.filter(m => ['Deployment', 'Job', 'Pod'].includes(m.kind));
    expect(pods.length).toBeGreaterThanOrEqual(5);
    for (const pod of pods) {
      const spec = podSpec(manifests, pod.kind, pod.metadata.name);
      expect(spec.securityContext?.runAsNonRoot).toBe(true);
      for (const container of allContainers(spec)) {
        expect(container.securityContext).toMatchObject({
          readOnlyRootFilesystem: true,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'] },
        });
      }
    }
  });
});

describe('pod annotations', () => {
  it('renders numeric --set values as strings', () => {
    const { manifests } = render(['podAnnotations.rollout=2']);
    const server = manifests.find(m => m.kind === 'Deployment' && m.metadata.name === 'mem-claude-mem-server');
    expect(server?.spec?.template?.metadata?.annotations?.rollout).toBe('2');
  });
});
