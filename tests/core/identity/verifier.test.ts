import { describe, expect, it } from 'bun:test';
import { formatAttributionTrailers } from '../../../src/core/identity/trailers.js';
import {
  describeAttribution,
  noRunBindings,
  verifyAttribution,
  type GitHubObjectRef,
  type RunBinding,
  type RunBindingSource
} from '../../../src/core/identity/verifier.js';

const runA = { agent: 'Author A', agentId: 'agent-a', run: 'run-a' };
const runB = { agent: 'Author B', agentId: 'agent-b', run: 'run-b' };

const commitOf = (sha: string): GitHubObjectRef => ({ kind: 'commit', sha });
const messageWith = (label: typeof runA) => `feat: change\n\n${formatAttributionTrailers(label)}`;

function bindingsOf(...bindings: RunBinding[]): RunBindingSource {
  return {
    bindingsFor: async (object) =>
      bindings.filter((binding) => JSON.stringify(binding.object) === JSON.stringify(object))
  };
}

describe('verifyAttribution in label mode', () => {
  it('resolves to unattributed when the object carries no trailers, never a default agent', async () => {
    const result = await verifyAttribution({
      object: commitOf('aaa'),
      text: 'fix: no trailers',
      bindings: bindingsOf({ object: commitOf('aaa'), runId: 'run-a', agentId: 'agent-a' })
    });

    expect(result).toEqual({ status: 'unattributed', reason: 'no_label' });
  });

  it('resolves a trailer with no run binding to unattributed, not the claimed agent', async () => {
    const result = await verifyAttribution({
      object: commitOf('aaa'),
      text: messageWith(runA),
      bindings: noRunBindings
    });

    expect(result).toEqual({ status: 'unattributed', reason: 'no_binding', selfAssertedLabel: runA });
  });

  it('attributes only when exactly one binding names the same run and agent as the trailer', async () => {
    const result = await verifyAttribution({
      object: commitOf('aaa'),
      text: messageWith(runA),
      bindings: bindingsOf({ object: commitOf('aaa'), runId: 'run-a', agentId: 'agent-a' })
    });

    expect(result).toEqual({
      status: 'attributed',
      object: commitOf('aaa'),
      runId: 'run-a',
      agentId: 'agent-a'
    });
  });

  it('never resolves a cross-run same-ref forgery to the copied run', async () => {
    const pushedByA = commitOf('aaa');
    const pushedByB = commitOf('bbb');
    const bindings = bindingsOf(
      { object: pushedByA, runId: 'run-a', agentId: 'agent-a' },
      { object: pushedByB, runId: 'run-b', agentId: 'agent-b' }
    );

    const forged = await verifyAttribution({ object: pushedByB, text: messageWith(runA), bindings });

    expect(forged.status).toBe('ambiguous');
    expect(forged.status === 'attributed' && forged.runId === 'run-a').toBe(false);
    expect(forged).toMatchObject({ reason: 'label_disagrees_with_binding', bindings: [{ runId: 'run-b' }] });
  });

  it('resolves two bindings claiming one object to ambiguous', async () => {
    const object = commitOf('aaa');
    const result = await verifyAttribution({
      object,
      text: messageWith(runA),
      bindings: bindingsOf(
        { object, runId: 'run-a', agentId: 'agent-a' },
        { object, runId: 'run-b', agentId: 'agent-b' }
      )
    });

    expect(result).toMatchObject({ status: 'ambiguous', reason: 'multiple_bindings' });
  });

  it('treats a redelivered identical binding as one binding', async () => {
    const object = commitOf('aaa');
    const binding = { object, runId: 'run-a', agentId: 'agent-a' };
    const result = await verifyAttribution({
      object,
      text: messageWith(runA),
      bindings: bindingsOf(binding, { ...binding })
    });

    expect(result.status).toBe('attributed');
  });

  it('ignores bindings the source returns for a different object', async () => {
    const result = await verifyAttribution({
      object: commitOf('aaa'),
      text: messageWith(runA),
      bindings: { bindingsFor: async () => [{ object: commitOf('zzz'), runId: 'run-a', agentId: 'agent-a' }] }
    });

    expect(result).toMatchObject({ status: 'unattributed', reason: 'no_binding' });
  });

  it('resolves a message with conflicting trailer values to ambiguous', async () => {
    const result = await verifyAttribution({
      object: commitOf('aaa'),
      text: `${messageWith(runA)}\nPaperclip-Agent-Id: agent-b`,
      bindings: noRunBindings
    });

    expect(result).toMatchObject({ status: 'ambiguous', reason: 'conflicting_label' });
  });

  it('resolves every object to unattributed or ambiguous while no binding source exists', async () => {
    const results = await Promise.all(
      [messageWith(runA), messageWith(runB), 'no trailers'].map((text) =>
        verifyAttribution({ object: { kind: 'pull_request', nodeId: 'PR_1' }, text, bindings: noRunBindings })
      )
    );

    expect(results.every((r) => r.status !== 'attributed')).toBe(true);
  });
});

describe('describeAttribution', () => {
  it('calls an unbound trailer a self-asserted label, never provenance', () => {
    const text = describeAttribution({ status: 'unattributed', reason: 'no_binding', selfAssertedLabel: runA });

    expect(text).toContain('self-asserted label');
    expect(text).not.toMatch(/\b(authored|written|introduced) by\b/i);
  });

  it('states exactly the claim a binding proves when attributed', () => {
    const text = describeAttribution({ status: 'attributed', object: commitOf('aaa'), runId: 'run-a', agentId: 'agent-a' });

    expect(text).toBe('attributed: commit aaa was introduced to GitHub by run run-a of agent agent-a (run binding)');
  });
});
