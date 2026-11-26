// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from 'fs';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { buildHardenedSdkOptions } from '../../../sdk/hardened-options.js';
import { OBSERVER_SESSIONS_DIR } from '../../../shared/paths.js';
import { findClaudeExecutable } from '../../../shared/find-claude-executable.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { ServerClassifiedProviderError } from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import { DEFAULT_SERVER_CLAUDE_MODEL } from './ClaudeObservationProvider.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

// Metered credentials outrank the OAuth token inside the CLI, so they never reach it.
const METERED_CREDENTIAL_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

export interface ClaudeCodeStreamMessage {
  type?: unknown;
  subtype?: unknown;
  error?: unknown;
  message?: unknown;
  result?: unknown;
  usage?: unknown;
  errors?: unknown;
}

export type ClaudeCodeQuery = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<ClaudeCodeStreamMessage>;

export interface ClaudeCodeObservationProviderOptions {
  oauthToken: string;
  model?: string;
  maxOutputTokens?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  queryImpl?: ClaudeCodeQuery;
  resolveExecutable?: () => string;
}

export class ClaudeCodeObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude-code' as const;
  private readonly oauthToken: string;
  private readonly model: string;
  private readonly maxOutputTokens: number | undefined;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly queryImpl: ClaudeCodeQuery;
  private readonly resolveExecutable: () => string;

  constructor(options: ClaudeCodeObservationProviderOptions) {
    if (!options.oauthToken) {
      throw new ServerClassifiedProviderError('CLAUDE_CODE_OAUTH_TOKEN not configured', {
        kind: 'auth_invalid',
        cause: new Error('oauthToken is required'),
      });
    }
    this.oauthToken = options.oauthToken;
    this.model = options.model ?? DEFAULT_SERVER_CLAUDE_MODEL;
    this.maxOutputTokens = options.maxOutputTokens;
    this.baseEnv = options.env ?? process.env;
    this.cwd = options.cwd ?? OBSERVER_SESSIONS_DIR;
    this.queryImpl = options.queryImpl ?? query;
    this.resolveExecutable = options.resolveExecutable ?? (() => findClaudeExecutable('SDK'));
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    try {
      return await this.runQuery(prompt, context, abortController);
    } catch (error) {
      if (error instanceof ServerClassifiedProviderError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      throw classifyClaudeCodeServerError({ detail: err.message, cause: err });
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private async runQuery(
    prompt: string,
    context: ServerGenerationContext,
    abortController: AbortController,
  ): Promise<ServerGenerationResult> {
    mkdirSync(this.cwd, { recursive: true });
    const options: Options = {
      ...buildHardenedSdkOptions({
        source: 'Observer',
        project: context.project.projectName ?? context.project.projectId,
        ...(context.project.serverSessionId ? { contentSessionId: context.project.serverSessionId } : {}),
        model: this.model,
        env: this.buildEnv(),
        pathToClaudeCodeExecutable: this.resolveExecutable(),
        cwd: this.cwd,
        abortController,
      }),
      maxTurns: 1,
    };

    const assistantText: string[] = [];
    let resultText: string | undefined;
    let tokensUsed: number | undefined;

    for await (const message of this.queryImpl({ prompt, options })) {
      if (message.type === 'assistant') {
        if (typeof message.error === 'string') {
          throw classifyClaudeCodeServerError({ assistantError: message.error, cause: new Error(message.error) });
        }
        assistantText.push(...extractTextBlocks(message.message));
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          const detail = Array.isArray(message.errors) ? message.errors.join('; ') : String(message.subtype);
          throw classifyClaudeCodeServerError({ detail, cause: new Error(`Claude Code result ${String(message.subtype)}: ${detail}`) });
        }
        if (typeof message.result === 'string') resultText = message.result;
        tokensUsed = sumUsageTokens(message.usage);
      }
    }

    const rawText = (resultText ?? assistantText.join('\n')).trim();
    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = sanitizeEnv(this.baseEnv);
    for (const name of METERED_CREDENTIAL_ENV_VARS) delete env[name];
    env.CLAUDE_CODE_OAUTH_TOKEN = this.oauthToken;
    if (this.maxOutputTokens !== undefined) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(this.maxOutputTokens);
    }
    return env;
  }
}

function extractTextBlocks(message: unknown): string[] {
  if (typeof message !== 'object' || message === null || !('content' in message)) return [];
  const { content } = message;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) =>
    typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string'
      ? [block.text]
      : [],
  );
}

function sumUsageTokens(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const input = 'input_tokens' in usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const output = 'output_tokens' in usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0);
}

interface ClassifyClaudeCodeInput {
  assistantError?: string;
  detail?: string;
  cause: unknown;
}

/**
 * Maps Claude Code SDK failures (assistant `error` codes, non-success results,
 * and CLI process errors) onto the server retry model.
 */
export function classifyClaudeCodeServerError(input: ClassifyClaudeCodeInput): ServerClassifiedProviderError {
  const lower = (input.detail ?? '').toLowerCase();
  switch (input.assistantError) {
    case 'authentication_failed':
      return new ServerClassifiedProviderError('Claude Code OAuth authentication failed', { kind: 'auth_invalid', cause: input.cause });
    case 'billing_error':
      return new ServerClassifiedProviderError('Claude Code subscription billing error', { kind: 'quota_exhausted', cause: input.cause });
    case 'rate_limit':
      return new ServerClassifiedProviderError('Claude Code subscription rate limit', { kind: 'rate_limit', cause: input.cause });
    case 'invalid_request':
      return new ServerClassifiedProviderError('Claude Code invalid request', { kind: 'unrecoverable', cause: input.cause });
    case 'server_error':
      return new ServerClassifiedProviderError('Claude Code upstream error', { kind: 'transient', cause: input.cause });
  }

  if (lower.includes('prompt is too long') || lower.includes('context window')) {
    return new ServerClassifiedProviderError('Claude Code context overflow', { kind: 'unrecoverable', cause: input.cause });
  }
  if (lower.includes('invalid api key') || lower.includes('oauth') || lower.includes('not logged in')) {
    return new ServerClassifiedProviderError('Claude Code OAuth authentication failed', { kind: 'auth_invalid', cause: input.cause });
  }
  if (lower.includes('usage limit') || lower.includes('rate limit')) {
    return new ServerClassifiedProviderError('Claude Code subscription rate limit', { kind: 'rate_limit', cause: input.cause });
  }
  return new ServerClassifiedProviderError(
    `Claude Code generation failed${input.detail ? `: ${input.detail.substring(0, 200)}` : ''}`,
    { kind: 'transient', cause: input.cause },
  );
}
