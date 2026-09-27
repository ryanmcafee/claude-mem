// SPDX-License-Identifier: Apache-2.0
//
// Build and query a knowledge corpus on a remote claude-mem server. No plugin,
// no worker, no local database — an API key and a project id are the whole
// configuration.
//
//   export CLAUDE_MEM_SERVER_URL=https://claude-mem.example.com
//   export CLAUDE_MEM_API_KEY=cm_...
//   export CLAUDE_MEM_PROJECT_ID=homelab
//   bun examples/remote-mode/corpus-client.ts
//
// Two behaviours differ from the local worker and are demonstrated below:
// priming is deterministic and optional, and the server keeps no conversation
// state, so follow-up questions carry their own history.

import { resolveRemoteModeConfig } from '../../src/shared/remote-mode.js';

// Throws with the name of the missing variable if the environment is incomplete.
const config = resolveRemoteModeConfig();

const CORPUS_NAME = 'remote-mode-example';

interface CorpusStats {
  observationCount: number;
  matchedCount: number;
  truncated: boolean;
  tokenEstimate: number;
  kindBreakdown: Record<string, number>;
}

interface Corpus {
  id: string;
  name: string;
  shared: boolean;
  foreign: boolean;
  contentDigest: string | null;
  stats: CorpusStats;
  /** Always null remotely: there is no resumable AI session to resume. */
  session_id: null;
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.serverUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const detail = await response.text();
    // 422 CorpusTooLarge and 422 SharedCorpusPrivateMembers arrive here with a
    // machine-readable reason; both mean "narrow the filter", not "retry".
    throw new Error(`${method} ${path} failed: ${response.status} ${detail}`);
  }
  return await response.json() as T;
}

const corpora = `/v1/projects/${encodeURIComponent(config.projectId)}/corpora`;

async function seedObservations(): Promise<void> {
  for (const content of [
    'Deploys roll forward through ArgoCD; a rollback syncs the previous revision.',
    'Before a kernel upgrade, drain the node and wait for workloads to reschedule.',
    'Secrets come from the 1Password operator via External Secrets, never from git.',
  ]) {
    await call('POST', '/v1/memories', { projectId: config.projectId, content });
  }
}

await seedObservations();

// Build. Synchronous: a select plus a deterministic render, no model call.
const { corpus } = await call<{ corpus: Corpus }>('POST', corpora, {
  name: CORPUS_NAME,
  description: 'Operational knowledge for the remote-mode example.',
  filter: {
    // `kinds` replaces the local `types`; `metadataMatch` replaces the local
    // `concepts`/`files`. An unsupported field is a 400, never ignored.
    query: 'deploy OR kernel OR secrets',
    limit: 100,
  },
});
console.log(`built ${corpus.name}: ${corpus.stats.observationCount} of ${corpus.stats.matchedCount} matches`
  + `${corpus.stats.truncated ? ' (truncated)' : ''}, ~${corpus.stats.tokenEstimate} tokens`);

// Prime is optional — query renders on demand if nothing is cached. Priming
// twice is a no-op, because the digest of an unchanged member set is the same.
const primed = await call<{ contentDigest: string; alreadyPrimed: boolean }>(
  'POST', `${corpora}/${CORPUS_NAME}/prime`, {},
);
const reprimed = await call<{ contentDigest: string; alreadyPrimed: boolean }>(
  'POST', `${corpora}/${CORPUS_NAME}/prime`, {},
);
console.log(`primed digest ${primed.contentDigest.slice(0, 19)}…`
  + ` (second prime alreadyPrimed=${reprimed.alreadyPrimed})`);

// Ask. Each call is independent, so a follow-up carries its own history.
const first = await call<{ answer: string }>('POST', `${corpora}/${CORPUS_NAME}/query`, {
  question: 'What has to happen before a kernel upgrade?',
});
console.log(`\nQ: What has to happen before a kernel upgrade?\nA: ${first.answer}`);

const followUp = await call<{ answer: string }>('POST', `${corpora}/${CORPUS_NAME}/query`, {
  question: 'And how do I undo it if it goes wrong?',
  history: [
    { role: 'user', content: 'What has to happen before a kernel upgrade?' },
    { role: 'assistant', content: first.answer },
  ],
});
console.log(`\nQ: And how do I undo it if it goes wrong?\nA: ${followUp.answer}`);

// Corpora other tenants published are discoverable with the shared opt-in, and
// are read by id: a name is only unique inside one tenant's project.
const discovered = await call<{ corpora: Corpus[] }>('GET', `${corpora}?scope=shared`);
const foreign = discovered.corpora.filter(entry => entry.foreign);
console.log(`\n${foreign.length} corpus/corpora published by other tenants`);
for (const entry of foreign) {
  const detail = await call<{ corpus: Corpus }>('GET', `/v1/corpora/${entry.id}`);
  console.log(`  - ${detail.corpus.name} (${detail.corpus.stats.observationCount} observations)`);
}

await call('DELETE', `${corpora}/${CORPUS_NAME}`);
console.log(`\ndeleted ${CORPUS_NAME}; its member observations are untouched`);
