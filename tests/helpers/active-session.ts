import type { ActiveSession } from '../../src/services/worker-types.js';

/**
 * One fixture for the required half of `ActiveSession`, so a field added to the
 * interface shows up as a single compile error here rather than silently
 * missing from every suite that builds its own session literal.
 */
export function makeActiveSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  const base: ActiveSession = {
    sessionDbId: 1,
    contentSessionId: 'test-session',
    memorySessionId: 'mem-session-123',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
  return { ...base, ...overrides };
}
