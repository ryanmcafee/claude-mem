// SPDX-License-Identifier: Apache-2.0
//
// Plain HTTP client for a remote claude-mem server. No SDK, no plugin, no
// worker — just fetch. This is the shape to port to any language.
//
//   export CLAUDE_MEM_SERVER_URL=https://claude-mem.example.com
//   export CLAUDE_MEM_API_KEY=cm_...
//   export CLAUDE_MEM_PROJECT_ID=homelab
//   bun examples/remote-mode/http-client.ts

import { resolveRemoteModeConfig } from '../../src/shared/remote-mode.js';

// Throws with the name of the missing variable if the environment is incomplete.
const config = resolveRemoteModeConfig();

type Scope = 'project' | 'shared';

interface Observation {
  id: string;
  teamId: string;
  content: string;
  shared: boolean;
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${config.serverUrl}${path}`, {
    method: 'POST',
    headers: {
      // Bearer is canonical; the server also accepts X-Api-Key.
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${path} failed: ${response.status} ${detail}`);
  }
  return await response.json() as T;
}

async function writeObservation(content: string, options: { shared?: boolean } = {}): Promise<Observation> {
  const { memory } = await call<{ memory: Observation }>('/v1/memories', {
    projectId: config.projectId,
    content,
    // Agent identity travels with the write so the row carries the full
    // project/tenant/agent triple.
    ...(config.agentId ? { metadata: { agentId: config.agentId } } : {}),
    // Needs memories:write:shared on the key; a plain key gets a 403 here
    // rather than a silently team-private write.
    ...(options.shared ? { shared: true } : {}),
  });
  return memory;
}

async function search(query: string, scope: Scope): Promise<Observation[]> {
  const { observations } = await call<{ observations: Observation[] }>('/v1/search', {
    projectId: config.projectId,
    query,
    // Omit `scope` (or send 'project') for your own tenant only.
    ...(scope === 'shared' ? { scope } : {}),
  });
  return observations;
}

async function contextPack(query: string, scope: Scope): Promise<string> {
  const { context } = await call<{ context: string }>('/v1/context', {
    projectId: config.projectId,
    query,
    ...(scope === 'shared' ? { scope } : {}),
  });
  return context;
}

const health = await fetch(`${config.serverUrl}/healthz`);
console.log(`server ${config.serverUrl} healthz: ${health.status}`);

const written = await writeObservation(
  'Remote-mode example wrote this observation over plain HTTP.',
);
console.log(`wrote ${written.id} (team ${written.teamId}, shared=${written.shared})`);

const own = await search('remote-mode example', 'project');
console.log(`\nown tenant (${own.length} result(s)):`);
for (const observation of own) console.log(`  - ${observation.content}`);

const shared = await search('remote-mode example', 'shared');
console.log(`\nwith shared scope (${shared.length} result(s)):`);
for (const observation of shared) {
  console.log(`  - [${observation.shared ? 'shared' : 'own'}] ${observation.content}`);
}

console.log('\ncontext pack ready for prompt injection:');
console.log(await contextPack('remote-mode example', 'project'));
