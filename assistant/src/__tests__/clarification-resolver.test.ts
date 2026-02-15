import { beforeEach, describe, expect, mock, test } from 'bun:test';

let llmCallCount = 0;
let llmDelayMs = 0;
let llmResolution: 'keep_existing' | 'keep_candidate' | 'merge' | 'still_unclear' = 'still_unclear';
let llmResolvedStatement = '';
let llmExplanation = 'Unclear response from user.';

mock.module('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: async (_body: unknown, opts?: { signal?: AbortSignal }) => {
        llmCallCount += 1;
        if (llmDelayMs > 0) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, llmDelayMs);
            opts?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('Request was aborted.'));
            });
          });
        }
        return {
          content: [{
            type: 'tool_use',
            input: {
              resolution: llmResolution,
              resolved_statement: llmResolvedStatement,
              explanation: llmExplanation,
            },
          }],
        };
      },
    };
  },
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    apiKeys: {
      anthropic: 'test-key',
    },
  }),
}));

import { resolveConflictClarification } from '../memory/clarification-resolver.js';

beforeEach(() => {
  llmCallCount = 0;
  llmDelayMs = 0;
  llmResolution = 'still_unclear';
  llmResolvedStatement = '';
  llmExplanation = 'Unclear response from user.';
});

describe('resolveConflictClarification', () => {
  test('returns keep_existing from deterministic heuristic', async () => {
    const result = await resolveConflictClarification({
      existingStatement: 'Use React for frontend work.',
      candidateStatement: 'Use Vue for frontend work.',
      userMessage: 'Keep the old React preference.',
    });

    expect(result.resolution).toBe('keep_existing');
    expect(result.strategy).toBe('heuristic');
    expect(llmCallCount).toBe(0);
  });

  test('returns keep_candidate from deterministic heuristic', async () => {
    const result = await resolveConflictClarification({
      existingStatement: 'Use React for frontend work.',
      candidateStatement: 'Use Vue for frontend work.',
      userMessage: 'Use the new Vue note going forward.',
    });

    expect(result.resolution).toBe('keep_candidate');
    expect(result.strategy).toBe('heuristic');
    expect(llmCallCount).toBe(0);
  });

  test('returns merge from deterministic heuristic', async () => {
    const result = await resolveConflictClarification({
      existingStatement: 'React is preferred for dashboards.',
      candidateStatement: 'Vue is preferred for marketing pages.',
      userMessage: 'Both are true: React for dashboards and Vue for marketing pages.',
    });

    expect(result.resolution).toBe('merge');
    expect(result.strategy).toBe('heuristic');
    expect(result.resolvedStatement).toContain('Both are true');
    expect(llmCallCount).toBe(0);
  });

  test('uses LLM fallback when heuristics are inconclusive', async () => {
    llmResolution = 'still_unclear';
    llmExplanation = 'The user message does not pick a side.';

    const result = await resolveConflictClarification({
      existingStatement: 'Use React for frontend work.',
      candidateStatement: 'Use Vue for frontend work.',
      userMessage: 'Not sure yet.',
    });

    expect(result.resolution).toBe('still_unclear');
    expect(result.strategy).toBe('llm');
    expect(llmCallCount).toBe(1);
  });

  test('does not match cue substrings inside unrelated words', async () => {
    llmResolution = 'keep_candidate';
    llmExplanation = 'User wants Vue.';

    // "told" contains "old" as a substring but not as a whole word
    const result = await resolveConflictClarification({
      existingStatement: 'Use React for frontend work.',
      candidateStatement: 'Use Vue for frontend work.',
      userMessage: 'I told you, use Vue.',
    });

    expect(result.resolution).toBe('keep_candidate');
    expect(result.strategy).toBe('llm');
    expect(llmCallCount).toBe(1);
  });

  test('delegates to LLM when multiple cue categories match', async () => {
    llmResolution = 'keep_existing';
    llmExplanation = 'User wants the old one.';

    // "either" is a merge cue, "old" is an existing cue — ambiguous
    const result = await resolveConflictClarification({
      existingStatement: 'Use React for frontend work.',
      candidateStatement: 'Use Vue for frontend work.',
      userMessage: "I don't want either, keep the old one.",
    });

    expect(result.resolution).toBe('keep_existing');
    expect(result.strategy).toBe('llm');
    expect(llmCallCount).toBe(1);
  });

  test('enforces timeout bound on LLM fallback', async () => {
    llmResolution = 'keep_candidate';
    llmExplanation = 'Prefer the newer statement.';
    llmDelayMs = 50;

    const result = await resolveConflictClarification(
      {
        existingStatement: 'Use React for frontend work.',
        candidateStatement: 'Use Vue for frontend work.',
        userMessage: 'I cannot decide right now.',
      },
      { timeoutMs: 5 },
    );

    expect(result.resolution).toBe('still_unclear');
    expect(result.strategy).toBe('llm_timeout');
    expect(llmCallCount).toBe(1);
  });
});
