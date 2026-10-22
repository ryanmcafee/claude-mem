// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { AttributionTrailers } from './agent-identity.js';
import { parseAttributionTrailers } from './trailers.js';

export const GitHubObjectRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit'), sha: z.string().min(1) }),
  z.object({ kind: z.enum(['pull_request', 'review', 'comment']), nodeId: z.string().min(1) })
]);

export const RunBindingSchema = z.looseObject({
  object: GitHubObjectRefSchema,
  runId: z.string().min(1),
  agentId: z.string().min(1)
});

export type GitHubObjectRef = z.infer<typeof GitHubObjectRefSchema>;
export type RunBinding = z.infer<typeof RunBindingSchema>;

export interface RunBindingSource {
  bindingsFor(object: GitHubObjectRef): Promise<readonly RunBinding[]>;
}

export const noRunBindings: RunBindingSource = { bindingsFor: async () => [] };

export type Attribution =
  | { status: 'attributed'; object: GitHubObjectRef; runId: string; agentId: string }
  | { status: 'unattributed'; reason: 'no_label' }
  | { status: 'unattributed'; reason: 'no_binding'; selfAssertedLabel: AttributionTrailers }
  | {
      status: 'ambiguous';
      reason: 'conflicting_label' | 'multiple_bindings' | 'label_disagrees_with_binding';
      selfAssertedLabel?: AttributionTrailers;
      bindings: RunBinding[];
    };

export interface VerifyAttributionInput {
  object: GitHubObjectRef;
  text: string;
  bindings: RunBindingSource;
}

function objectKey(object: GitHubObjectRef): string {
  return object.kind === 'commit' ? `commit:${object.sha}` : `${object.kind}:${object.nodeId}`;
}

async function distinctBindingsFor(source: RunBindingSource, object: GitHubObjectRef): Promise<RunBinding[]> {
  const target = objectKey(object);
  const byClaim = new Map<string, RunBinding>();
  for (const raw of await source.bindingsFor(object)) {
    const binding = RunBindingSchema.parse(raw);
    if (objectKey(binding.object) !== target) continue;
    byClaim.set(JSON.stringify([binding.runId, binding.agentId]), binding);
  }
  return [...byClaim.values()];
}

export async function verifyAttribution({ object, text, bindings }: VerifyAttributionInput): Promise<Attribution> {
  const parsed = parseAttributionTrailers(text);
  if (parsed.status === 'conflicting') {
    return { status: 'ambiguous', reason: 'conflicting_label', bindings: await distinctBindingsFor(bindings, object) };
  }
  if (parsed.status !== 'label') return { status: 'unattributed', reason: 'no_label' };

  const label = parsed.label;
  const claims = await distinctBindingsFor(bindings, object);
  if (claims.length === 0) return { status: 'unattributed', reason: 'no_binding', selfAssertedLabel: label };
  if (claims.length > 1) {
    return { status: 'ambiguous', reason: 'multiple_bindings', selfAssertedLabel: label, bindings: claims };
  }

  const [binding] = claims;
  if (binding.runId !== label.run || binding.agentId !== label.agentId) {
    return { status: 'ambiguous', reason: 'label_disagrees_with_binding', selfAssertedLabel: label, bindings: claims };
  }
  return { status: 'attributed', object, runId: binding.runId, agentId: binding.agentId };
}

function describeObject(object: GitHubObjectRef): string {
  return object.kind === 'commit' ? `commit ${object.sha}` : `${object.kind.replace('_', ' ')} ${object.nodeId}`;
}

function describeLabel(label: AttributionTrailers | undefined): string {
  return label ? `self-asserted label (agent id ${label.agentId}, run ${label.run})` : 'self-asserted label';
}

export function describeAttribution(attribution: Attribution): string {
  switch (attribution.status) {
    case 'attributed':
      return `attributed: ${describeObject(attribution.object)} was introduced to GitHub by run ${attribution.runId} of agent ${attribution.agentId} (run binding)`;
    case 'unattributed':
      return attribution.reason === 'no_label'
        ? 'unattributed: no Paperclip attribution trailers'
        : `unattributed: ${describeLabel(attribution.selfAssertedLabel)} with no run binding`;
    case 'ambiguous':
      return `ambiguous (${attribution.reason.replaceAll('_', ' ')}): ${describeLabel(attribution.selfAssertedLabel)}, ${attribution.bindings.length} run binding(s)`;
  }
}
