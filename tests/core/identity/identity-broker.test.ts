import { describe, expect, it } from 'bun:test';
import { createInMemoryIdentityBroker } from '../../../src/core/identity/identity-broker.js';

const principals = { author: 'opaque:author', review: 'opaque:review' };
const reviewer = { runId: 'run-r', subject: 'agent-r', agent: 'Reviewer' };
const author = { runId: 'run-a', subject: 'agent-a', agent: 'Author' };

function brokerWithRuns() {
  const broker = createInMemoryIdentityBroker({ principals });
  broker.bindRunRole({ ...reviewer, role: 'review' });
  broker.bindRunRole({ ...author, role: 'author' });
  return broker;
}

describe('IdentityBroker role selection', () => {
  it('issues the bound role with trailers naming the run and agent', async () => {
    const result = await brokerWithRuns().requestIdentity({ runId: 'run-a', role: 'author' });

    expect(result).toEqual({
      ok: true,
      identity: {
        subject: 'agent-a',
        role: 'author',
        principalRef: 'opaque:author',
        attributionTrailers: { agent: 'Author', agentId: 'agent-a', run: 'run-a' }
      }
    });
  });

  it('denies a review-bound run that asks for author', async () => {
    const result = await brokerWithRuns().requestIdentity({ runId: 'run-r', role: 'author' });

    expect(result).toEqual({ ok: false, reason: 'role_mismatch' });
  });

  it('denies an unknown role', async () => {
    const result = await brokerWithRuns().requestIdentity({ runId: 'run-a', role: 'admin' });

    expect(result).toEqual({ ok: false, reason: 'unknown_role' });
  });

  it('denies a run with no bound role', async () => {
    const result = await brokerWithRuns().requestIdentity({ runId: 'run-unknown', role: 'review' });

    expect(result).toEqual({ ok: false, reason: 'run_not_bound' });
  });

  it('refuses to change a run role once bound', async () => {
    const broker = brokerWithRuns();

    expect(broker.bindRunRole({ ...reviewer, role: 'author' })).toEqual({ ok: false, reason: 'role_already_bound' });
    expect(await broker.requestIdentity({ runId: 'run-r', role: 'author' })).toEqual({ ok: false, reason: 'role_mismatch' });
    expect((await broker.requestIdentity({ runId: 'run-r', role: 'review' })).ok).toBe(true);
  });

  it('accepts an identical re-bind so at-least-once delivery is idempotent', () => {
    expect(brokerWithRuns().bindRunRole({ ...reviewer, role: 'review' })).toEqual({ ok: true });
  });

  it('refuses to bind a role no principal is configured for', () => {
    const broker = createInMemoryIdentityBroker({ principals: { author: 'opaque:author' } });

    expect(broker.bindRunRole({ ...reviewer, role: 'review' })).toEqual({ ok: false, reason: 'no_principal_for_role' });
  });

  it('serves run bindings through the same seam, with none recorded by default', async () => {
    expect(await brokerWithRuns().bindingsFor({ kind: 'commit', sha: 'aaa' })).toEqual([]);
  });
});
