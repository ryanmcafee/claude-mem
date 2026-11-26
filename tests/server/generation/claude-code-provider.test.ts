// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeCodeObservationProvider,
  classifyClaudeCodeServerError,
  type ClaudeCodeStreamMessage,
} from '../../../src/server/generation/providers/ClaudeCodeObservationProvider.js';
import { ServerClassifiedProviderError } from '../../../src/server/generation/providers/shared/error-classification.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';
import { buildServerGenerationProviderFromEnv } from '../../../src/server/runtime/create-server-service.js';

function makeContext(payload: unknown = { tool: 'bash', input: 'ls' }): ServerGenerationContext {
  return {
    job: {
      id: 'job-1',
      projectId: 'proj-1',
      teamId: 'team-1',
      agentEventId: 'evt-1',
      sourceType: 'agent_event',
      sourceId: 'evt-1',
      serverSessionId: null,
      jobType: 'observation_generate_for_event',
      status: 'processing',
      idempotencyKey: 'k',
      bullmqJobId: null,
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAtEpoch: null,
      lockedAtEpoch: null,
      lockedBy: null,
      completedAtEpoch: null,
      failedAtEpoch: null,
      cancelledAtEpoch: null,
      lastError: null,
      payload: {},
      createdAtEpoch: 0,
      updatedAtEpoch: 0,
    },
    events: [
      {
        id: 'evt-1',
        projectId: 'proj-1',
        teamId: 'team-1',
        serverSessionId: null,
        sourceAdapter: 'api',
        sourceEventId: null,
        idempotencyKey: 'k',
        eventType: 'tool_use',
        payload,
        metadata: {},
        occurredAtEpoch: 0,
        receivedAtEpoch: 0,
        createdAtEpoch: 0,
      },
    ],
    project: { projectId: 'proj-1', teamId: 'team-1', serverSessionId: null, projectName: 'demo' },
  };
}

interface RecordedCall {
  prompt: string;
  options: Options;
}

function fakeQuery(messages: ClaudeCodeStreamMessage[], calls: RecordedCall[] = []) {
  return async function* (params: { prompt: string; options: Options }) {
    calls.push(params);
    yield* messages;
  };
}

const OBSERVATION = '<observation><type>discovery</type><title>t</title></observation>';

describe('ClaudeCodeObservationProvider', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'claude-code-provider-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeProvider(messages: ClaudeCodeStreamMessage[], calls: RecordedCall[] = [], env: NodeJS.ProcessEnv = {}) {
    return new ClaudeCodeObservationProvider({
      oauthToken: 'oauth-token',
      env,
      cwd,
      queryImpl: fakeQuery(messages, calls),
      resolveExecutable: () => '/usr/local/bin/claude',
    });
  }

  it('rejects construction without an OAuth token', () => {
    expect(() => new ClaudeCodeObservationProvider({ oauthToken: '' })).toThrow(ServerClassifiedProviderError);
  });

  it('returns the success result text and token usage', async () => {
    const provider = makeProvider([
      { type: 'assistant', message: { content: [{ type: 'text', text: OBSERVATION }] } },
      { type: 'result', subtype: 'success', result: OBSERVATION, usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
    const result = await provider.generate(makeContext());
    expect(result.rawText).toBe(OBSERVATION);
    expect(result.tokensUsed).toBe(30);
    expect(result.providerLabel).toBe('claude-code');
  });

  it('falls back to assistant text when the result carries none', async () => {
    const provider = makeProvider([
      { type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'text', text: OBSERVATION }] } },
      { type: 'result', subtype: 'success' },
    ]);
    const result = await provider.generate(makeContext());
    expect(result.rawText).toBe(OBSERVATION);
    expect(result.tokensUsed).toBeUndefined();
  });

  it('authenticates with the OAuth token only and keeps metered keys away from the CLI', async () => {
    const calls: RecordedCall[] = [];
    const provider = makeProvider(
      [{ type: 'result', subtype: 'success', result: OBSERVATION }],
      calls,
      { ANTHROPIC_API_KEY: 'sk-metered', ANTHROPIC_AUTH_TOKEN: 'metered', PATH: '/usr/bin' },
    );
    await provider.generate(makeContext());
    const env = calls[0]?.options.env ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('runs a single turn with every tool disabled', async () => {
    const calls: RecordedCall[] = [];
    await makeProvider([{ type: 'result', subtype: 'success', result: OBSERVATION }], calls).generate(makeContext());
    const options = calls[0]?.options;
    expect(options?.maxTurns).toBe(1);
    expect(options?.tools).toEqual([]);
    expect(options?.permissionMode).toBe('dontAsk');
    expect(options?.cwd).toBe(cwd);
    expect(options?.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude');
  });

  it('skips the CLI when every event is private', async () => {
    const calls: RecordedCall[] = [];
    const result = await makeProvider([], calls).generate(makeContext('<private>secret</private>'));
    expect(result.rawText).toContain('<skip_summary');
    expect(calls).toHaveLength(0);
  });

  it('classifies an assistant authentication_failed error as auth_invalid', async () => {
    const provider = makeProvider([{ type: 'assistant', error: 'authentication_failed', message: { content: [] } }]);
    const error = await provider.generate(makeContext()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ServerClassifiedProviderError);
    expect(error instanceof ServerClassifiedProviderError && error.kind).toBe('auth_invalid');
  });

  it('classifies a non-success result as an error', async () => {
    const provider = makeProvider([{ type: 'result', subtype: 'error_during_execution', errors: ['boom'] }]);
    const error = await provider.generate(makeContext()).catch((err: unknown) => err);
    expect(error instanceof ServerClassifiedProviderError && error.kind).toBe('transient');
  });

  it('classifies a thrown CLI failure instead of leaking a raw error', async () => {
    const provider = new ClaudeCodeObservationProvider({
      oauthToken: 'oauth-token',
      cwd,
      queryImpl: () => {
        throw new Error('Claude Code process exited with code 1: Invalid API key');
      },
      resolveExecutable: () => '/usr/local/bin/claude',
    });
    const error = await provider.generate(makeContext()).catch((err: unknown) => err);
    expect(error instanceof ServerClassifiedProviderError && error.kind).toBe('auth_invalid');
  });
});

describe('classifyClaudeCodeServerError', () => {
  for (const [assistantError, kind] of [
    ['authentication_failed', 'auth_invalid'],
    ['billing_error', 'quota_exhausted'],
    ['rate_limit', 'rate_limit'],
    ['invalid_request', 'unrecoverable'],
    ['server_error', 'transient'],
  ] as const) {
    it(`maps assistant error ${assistantError} to ${kind}`, () => {
      expect(classifyClaudeCodeServerError({ assistantError, cause: new Error(assistantError) }).kind).toBe(kind);
    });
  }

  it('maps a context overflow detail to unrecoverable', () => {
    expect(classifyClaudeCodeServerError({ detail: 'Prompt is too long', cause: 'x' }).kind).toBe('unrecoverable');
  });
});

describe('buildServerGenerationProviderFromEnv claude-code selection', () => {
  const keys = ['CLAUDE_MEM_SERVER_PROVIDER', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
  const saved: Partial<Record<(typeof keys)[number], string>> = {};
  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('builds the claude-code provider from CLAUDE_CODE_OAUTH_TOKEN', () => {
    process.env.CLAUDE_MEM_SERVER_PROVIDER = 'claude-code';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
    expect(buildServerGenerationProviderFromEnv()?.providerLabel).toBe('claude-code');
  });

  it('leaves generation disabled when the OAuth token is missing', () => {
    process.env.CLAUDE_MEM_SERVER_PROVIDER = 'claude-code';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(buildServerGenerationProviderFromEnv()).toBeNull();
  });
});
