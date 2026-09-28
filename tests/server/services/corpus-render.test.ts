// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';

import { renderCorpus } from '../../../src/server/services/corpus-render.js';
import type { PostgresCorpusMember } from '../../../src/storage/postgres/corpora.js';
import type { CorpusFilter } from '../../../src/server/contracts/corpus-v1.js';

const FILTER: CorpusFilter = { scope: 'project' };

function member(overrides: Partial<PostgresCorpusMember> = {}): PostgresCorpusMember {
  return {
    id: 'obs-1',
    projectId: 'alpha-project',
    kind: 'decision',
    content: 'drain the node before rollback',
    metadata: { agentId: 'agent-alpha-7', sourceAdapter: 'claude' },
    shared: true,
    createdAtEpoch: 1_700_000_000_000,
    updatedAtEpoch: 1_700_000_000_000,
    ...overrides,
  };
}

function render(redactProvenance: boolean): string {
  return renderCorpus({
    name: 'rollbacks',
    description: 'How rollbacks work',
    filter: FILTER,
    members: [member()],
    redactProvenance,
  }).rendered;
}

describe('MCAA-260 — corpus render provenance redaction', () => {
  it('gives the owning tenant the member metadata', () => {
    const rendered = render(false);
    expect(rendered).toContain('drain the node before rollback');
    expect(rendered).toContain('**Metadata:**');
    expect(rendered).toContain('agent-alpha-7');
  });

  it('keeps content but drops metadata for a reader outside the owning tenant', () => {
    const rendered = render(true);
    expect(rendered).toContain('drain the node before rollback');
    expect(rendered).not.toContain('**Metadata:**');
    expect(rendered).not.toContain('agent-alpha-7');
    expect(rendered).not.toContain('sourceAdapter');
  });

  it('stays deterministic, so the digest remains a usable cache key per perspective', () => {
    expect(render(true)).toBe(render(true));
    expect(render(false)).toBe(render(false));
    // The two perspectives must differ, which is why a foreign read may not be
    // answered from an artifact cached under the owner's render.
    expect(render(true)).not.toBe(render(false));
  });

  it('redacts every member, not just the first', () => {
    const rendered = renderCorpus({
      name: 'rollbacks',
      description: 'How rollbacks work',
      filter: FILTER,
      members: [
        member(),
        member({ id: 'obs-2', content: 'restart the operator last', metadata: { agentId: 'agent-alpha-9' } }),
      ],
      redactProvenance: true,
    }).rendered;
    expect(rendered).toContain('restart the operator last');
    expect(rendered).not.toContain('agent-alpha-9');
    expect(rendered).not.toContain('**Metadata:**');
  });
});
