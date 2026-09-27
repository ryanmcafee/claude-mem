// SPDX-License-Identifier: Apache-2.0
//
// The model seam for `query_corpus` (MCAA-260).
//
// Priming is deterministic and model-free (ADR 0001 D4); answering is the one
// corpus operation that calls a model. It is an interface so the route layer
// and its tests never need a provider, and so a deployment with no provider
// configured fails with one clear message instead of an opaque provider error.

import { resolveOpenRouterChatCompletionsUrl } from '../../shared/openrouter-base-url.js';
import { openRouterAttributionHeaders } from '../../shared/openrouter-attribution.js';
import { logger } from '../../utils/logger.js';

export interface CorpusAnswerTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CorpusAnswerRequest {
  systemPrompt: string;
  /** The rendered corpus, used as a stable prompt prefix. */
  rendered: string;
  question: string;
  /** Prior turns, oldest first. The server holds no conversation state. */
  history: readonly CorpusAnswerTurn[];
}

export interface CorpusAnswerer {
  answer(request: CorpusAnswerRequest, signal?: AbortSignal): Promise<string>;
}

export class CorpusAnswererUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusAnswererUnavailableError';
  }
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** The corpus is the prefix; the question is the last user turn. */
function buildTurns(request: CorpusAnswerRequest): CorpusAnswerTurn[] {
  return [
    { role: 'user', content: `${request.rendered}\n\nUse the corpus above to answer the questions that follow.` },
    { role: 'assistant', content: 'Understood. I will answer only from the corpus above.' },
    ...request.history,
    { role: 'user', content: request.question },
  ];
}

async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return '';
  }
}

function failed(provider: string, status: number, body: string): Error {
  // Provider text can echo the prompt, which is corpus content. Keep the
  // status and the provider; never fold the body into the client-facing error.
  logger.warn('SYSTEM', 'corpus answer provider call failed', { provider, status, body });
  return new Error(`The knowledge provider (${provider}) returned status ${status}.`);
}

export class AnthropicCorpusAnswerer implements CorpusAnswerer {
  constructor(private readonly options: {
    apiKey: string;
    model: string;
    maxOutputTokens?: number;
    fetchImpl?: typeof fetch;
  }) {}

  async answer(request: CorpusAnswerRequest, signal?: AbortSignal): Promise<string> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        system: request.systemPrompt,
        messages: buildTurns(request),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw failed('anthropic', response.status, await readBody(response));
    const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    return (data.content ?? [])
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text!)
      .join('\n')
      .trim();
  }
}

/** OpenRouter and any other OpenAI-compatible chat-completions gateway. */
export class OpenAICompatibleCorpusAnswerer implements CorpusAnswerer {
  constructor(private readonly options: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    maxOutputTokens?: number;
    fetchImpl?: typeof fetch;
  }) {}

  async answer(request: CorpusAnswerRequest, signal?: AbortSignal): Promise<string> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(resolveOpenRouterChatCompletionsUrl(this.options.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
        ...openRouterAttributionHeaders(),
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        messages: [{ role: 'system', content: request.systemPrompt }, ...buildTurns(request)],
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw failed('openrouter', response.status, await readBody(response));
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }
}

export class GeminiCorpusAnswerer implements CorpusAnswerer {
  constructor(private readonly options: {
    apiKey: string;
    model: string;
    maxOutputTokens?: number;
    fetchImpl?: typeof fetch;
  }) {}

  async answer(request: CorpusAnswerRequest, signal?: AbortSignal): Promise<string> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = `${GEMINI_API_URL}/${encodeURIComponent(this.options.model)}:generateContent`
      + `?key=${encodeURIComponent(this.options.apiKey)}`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.systemPrompt }] },
        contents: buildTurns(request).map(turn => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turn.content }],
        })),
        generationConfig: { maxOutputTokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS },
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw failed('gemini', response.status, await readBody(response));
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map(part => part.text ?? '')
      .join('')
      .trim();
  }
}

/**
 * Build the answerer from the same provider env the generation path already
 * uses, so a server that can generate observations can also answer corpus
 * questions with no extra configuration. Returns null when no provider is
 * configured; the route turns that into one actionable error rather than
 * pretending a corpus can be queried.
 */
export function createCorpusAnswererFromEnv(env: NodeJS.ProcessEnv = process.env): CorpusAnswerer | null {
  const provider = (env.CLAUDE_MEM_SERVER_PROVIDER ?? '').trim().toLowerCase();
  const maxOutputTokensRaw = Number(env.CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS ?? '');
  const maxOutputTokens = Number.isInteger(maxOutputTokensRaw) && maxOutputTokensRaw > 0
    ? maxOutputTokensRaw
    : undefined;
  const model = env.CLAUDE_MEM_SERVER_MODEL;

  if (provider === 'claude' || provider === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY ?? env.CLAUDE_MEM_ANTHROPIC_API_KEY ?? '';
    if (!apiKey) return null;
    return new AnthropicCorpusAnswerer({
      apiKey,
      model: model ?? 'claude-sonnet-5',
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });
  }
  if (provider === 'gemini') {
    const apiKey = env.GEMINI_API_KEY ?? env.CLAUDE_MEM_GEMINI_API_KEY ?? '';
    if (!apiKey) return null;
    return new GeminiCorpusAnswerer({
      apiKey,
      model: model ?? 'gemini-flash-latest',
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });
  }
  if (provider === 'openrouter') {
    const apiKey = env.OPENROUTER_API_KEY ?? env.CLAUDE_MEM_OPENROUTER_API_KEY ?? '';
    if (!apiKey) return null;
    const baseUrl = env.CLAUDE_MEM_OPENROUTER_BASE_URL ?? env.OPENROUTER_BASE_URL;
    return new OpenAICompatibleCorpusAnswerer({
      apiKey,
      model: model ?? 'anthropic/claude-3.5-sonnet',
      ...(baseUrl ? { baseUrl } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });
  }
  return null;
}
