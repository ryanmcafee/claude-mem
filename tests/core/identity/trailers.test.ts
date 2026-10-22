import { describe, expect, it } from 'bun:test';
import {
  appendAttributionTrailers,
  formatAttributionTrailers,
  parseAttributionTrailers
} from '../../../src/core/identity/trailers.js';

const label = {
  agent: 'Senior Application Engineer',
  agentId: 'agent-7f3a',
  run: 'run-0001'
};

const commitMessage = [
  'feat(identity): add the trailer parser',
  '',
  'Body text.',
  '',
  'Paperclip-Agent: Senior Application Engineer',
  'Paperclip-Agent-Id: agent-7f3a',
  'Paperclip-Run: run-0001',
  'Co-Authored-By: Someone <someone@example.com>'
].join('\n');

describe('attribution trailers', () => {
  it('formats the three trailers in a fixed order', () => {
    expect(formatAttributionTrailers(label)).toBe(
      'Paperclip-Agent: Senior Application Engineer\nPaperclip-Agent-Id: agent-7f3a\nPaperclip-Run: run-0001'
    );
  });

  it('parses a commit message carrying the three trailers back to the same agent id', () => {
    expect(parseAttributionTrailers(commitMessage)).toEqual({ status: 'label', label });
  });

  it('round-trips a PR body footer written by appendAttributionTrailers', () => {
    const body = appendAttributionTrailers('Why this change matters.\n', label);

    expect(parseAttributionTrailers(body)).toEqual({ status: 'label', label });
  });

  it('adds to an existing trailer block instead of starting a second one', () => {
    const message = appendAttributionTrailers('fix: x\n\nCo-Authored-By: A <a@example.com>', label);

    expect(message).toBe(
      'fix: x\n\nCo-Authored-By: A <a@example.com>\n' + formatAttributionTrailers(label)
    );
  });

  it('still parses when an unknown extra Paperclip-* trailer is present', () => {
    const message = commitMessage + '\nPaperclip-Tenant: local\nPaperclip-Future-Field: v2';

    expect(parseAttributionTrailers(message)).toEqual({ status: 'label', label });
  });

  it('matches trailer keys case-insensitively, as git does', () => {
    const message = 'x\n\npaperclip-agent: A\nPAPERCLIP-AGENT-ID: agent-7f3a\nPaperclip-run: run-0001';

    expect(parseAttributionTrailers(message)).toEqual({
      status: 'label',
      label: { agent: 'A', agentId: 'agent-7f3a', run: 'run-0001' }
    });
  });

  it('yields absent for a message with no trailers, never a default agent', () => {
    expect(parseAttributionTrailers('fix: something\n\nNo trailers here.')).toEqual({ status: 'absent' });
    expect(parseAttributionTrailers('')).toEqual({ status: 'absent' });
  });

  it('ignores Paperclip-* lines that sit in the body rather than the final trailer block', () => {
    const message = 'x\n\nPaperclip-Agent-Id: agent-7f3a\nPaperclip-Run: run-0001\nPaperclip-Agent: A\n\nTrailing prose.';

    expect(parseAttributionTrailers(message)).toEqual({ status: 'absent' });
  });

  it('yields incomplete when only some of the three trailers are present', () => {
    expect(parseAttributionTrailers('x\n\nPaperclip-Agent-Id: agent-7f3a')).toEqual({
      status: 'incomplete',
      missing: ['Paperclip-Agent', 'Paperclip-Run']
    });
  });

  it('yields conflicting when one trailer key carries two different values', () => {
    const message = commitMessage + '\nPaperclip-Agent-Id: agent-other';

    expect(parseAttributionTrailers(message)).toEqual({
      status: 'conflicting',
      keys: ['Paperclip-Agent-Id']
    });
  });

  it('refuses to format a value containing a line break', () => {
    expect(() => formatAttributionTrailers({ ...label, run: 'run\nPaperclip-Agent-Id: forged' })).toThrow();
  });
});
