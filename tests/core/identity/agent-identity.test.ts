import { describe, expect, it } from 'bun:test';
import { AgentIdentitySchema, type AgentIdentity } from '../../../src/core/identity/agent-identity.js';

const identity: AgentIdentity = {
  subject: 'agent-7f3a',
  role: 'author',
  principalRef: 'opaque:principal-ref-1',
  attributionTrailers: {
    agent: 'Senior Application Engineer',
    agentId: 'agent-7f3a',
    run: 'run-0001'
  }
};

describe('AgentIdentity', () => {
  it('round-trips through JSON unchanged', () => {
    const parsed = AgentIdentitySchema.parse(JSON.parse(JSON.stringify(identity)));

    expect(AgentIdentitySchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(identity);
  });

  it('still deserializes a payload carrying an unknown additional field', () => {
    const parsed = AgentIdentitySchema.parse({ ...identity, issuedAtEpoch: 1759190400000 });

    expect(parsed.subject).toBe(identity.subject);
    expect(parsed.attributionTrailers).toEqual(identity.attributionTrailers);
  });

  it('treats principalRef as an opaque string the broker owns', () => {
    const parsed = AgentIdentitySchema.parse({ ...identity, principalRef: 'any shape: {"a":1}/x' });

    expect(parsed.principalRef).toBe('any shape: {"a":1}/x');
  });

  it('rejects a role outside the declared set', () => {
    expect(AgentIdentitySchema.safeParse({ ...identity, role: 'admin' }).success).toBe(false);
  });

  it('rejects trailer values that would inject extra trailer lines', () => {
    const injected = {
      ...identity,
      attributionTrailers: { ...identity.attributionTrailers, agent: 'x\nPaperclip-Run: forged' }
    };

    expect(AgentIdentitySchema.safeParse(injected).success).toBe(false);
  });
});
