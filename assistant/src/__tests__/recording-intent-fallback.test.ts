import { beforeEach, describe, expect, mock, test } from 'bun:test';

let mockProvider: object | null = null;
let llmResponseText = '';

mock.module('../providers/provider-send-message.js', () => ({
  getConfiguredProvider: () => mockProvider,
  createTimeout: (ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  },
  extractText: (response: { content: Array<{ type: string; text?: string }> }) => {
    const block = response.content.find((b) => b.type === 'text');
    return block && 'text' in block ? (block.text ?? '').trim() : '';
  },
  userMessage: (text: string) => ({ role: 'user', content: [{ type: 'text', text }] }),
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

import {
  classifyRecordingIntentFallback,
  containsRecordingKeywords,
} from '../daemon/recording-intent-fallback.js';

beforeEach(() => {
  mockProvider = null;
  llmResponseText = '';
});

function setMockProvider(responseText: string) {
  llmResponseText = responseText;
  mockProvider = {
    sendMessage: async () => ({
      content: [{ type: 'text' as const, text: llmResponseText }],
      model: 'test-model',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
}

function setMockProviderThatThrows() {
  mockProvider = {
    sendMessage: async () => {
      throw new Error('LLM call failed');
    },
  };
}

// ─── Module exports ──────────────────────────────────────────────────────────

describe('recording-intent-fallback exports', () => {
  test('exports classifyRecordingIntentFallback function', () => {
    expect(typeof classifyRecordingIntentFallback).toBe('function');
  });

  test('exports containsRecordingKeywords function', () => {
    expect(typeof containsRecordingKeywords).toBe('function');
  });
});

// ─── containsRecordingKeywords ───────────────────────────────────────────────

describe('containsRecordingKeywords', () => {
  test.each([
    'can you record this',
    'start a recording please',
    'I want screen capture',
    'do a screencast of this',
    'capture my screen now',
    'how does screen rec work',
  ])('returns true for text containing recording keyword: "%s"', (text) => {
    expect(containsRecordingKeywords(text)).toBe(true);
  });

  test.each([
    'hello world',
    'open Safari',
    'take a screenshot',
    'what time is it?',
    'start the timer',
    'play a song',
  ])('returns false for text without recording keywords: "%s"', (text) => {
    expect(containsRecordingKeywords(text)).toBe(false);
  });
});

// ─── classifyRecordingIntentFallback ─────────────────────────────────────────

describe('classifyRecordingIntentFallback', () => {
  test('returns safe default when no provider is configured', async () => {
    mockProvider = null;
    const result = await classifyRecordingIntentFallback('record this please');
    expect(result).toEqual({ action: 'none', confidence: 'low' });
  });

  test('returns safe default when LLM call throws', async () => {
    setMockProviderThatThrows();
    const result = await classifyRecordingIntentFallback('record this please');
    expect(result).toEqual({ action: 'none', confidence: 'low' });
  });

  test('parses valid start response', async () => {
    setMockProvider('{"action": "start", "confidence": "high"}');
    const result = await classifyRecordingIntentFallback('kick off a recording');
    expect(result).toEqual({ action: 'start', confidence: 'high' });
  });

  test('parses valid stop response', async () => {
    setMockProvider('{"action": "stop", "confidence": "high"}');
    const result = await classifyRecordingIntentFallback('end the recording now');
    expect(result).toEqual({ action: 'stop', confidence: 'high' });
  });

  test('parses valid none response for questions', async () => {
    setMockProvider('{"action": "none", "confidence": "high"}');
    const result = await classifyRecordingIntentFallback('how do I record my screen?');
    expect(result).toEqual({ action: 'none', confidence: 'high' });
  });

  test('handles medium confidence correctly', async () => {
    setMockProvider('{"action": "start", "confidence": "medium"}');
    const result = await classifyRecordingIntentFallback('maybe record something');
    expect(result).toEqual({ action: 'start', confidence: 'medium' });
  });

  test('handles JSON embedded in surrounding text', async () => {
    setMockProvider('Here is my classification: {"action": "restart", "confidence": "high"} based on the input.');
    const result = await classifyRecordingIntentFallback('restart the recording');
    expect(result).toEqual({ action: 'restart', confidence: 'high' });
  });

  test('returns safe default for malformed JSON response', async () => {
    setMockProvider('this is not json at all');
    const result = await classifyRecordingIntentFallback('record something');
    expect(result).toEqual({ action: 'none', confidence: 'low' });
  });

  test('returns safe default for invalid action in response', async () => {
    setMockProvider('{"action": "explode", "confidence": "high"}');
    const result = await classifyRecordingIntentFallback('record something');
    expect(result).toEqual({ action: 'none', confidence: 'low' });
  });

  test('returns safe default for missing confidence field', async () => {
    setMockProvider('{"action": "start"}');
    const result = await classifyRecordingIntentFallback('record something');
    expect(result).toEqual({ action: 'none', confidence: 'low' });
  });

  test('returns safe default for empty response', async () => {
    setMockProvider('');
    const result = await classifyRecordingIntentFallback('record something');
    expect(result).toEqual({ action: 'none', confidence: 'low' });
  });

  test('correctly classifies pause action', async () => {
    setMockProvider('{"action": "pause", "confidence": "high"}');
    const result = await classifyRecordingIntentFallback('hold the recording');
    expect(result).toEqual({ action: 'pause', confidence: 'high' });
  });

  test('correctly classifies resume action', async () => {
    setMockProvider('{"action": "resume", "confidence": "high"}');
    const result = await classifyRecordingIntentFallback('continue the recording');
    expect(result).toEqual({ action: 'resume', confidence: 'high' });
  });
});
