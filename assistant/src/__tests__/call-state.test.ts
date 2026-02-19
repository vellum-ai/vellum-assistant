import { describe, test, expect, beforeEach, mock } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import {
  registerCallQuestionNotifier,
  unregisterCallQuestionNotifier,
  fireCallQuestionNotifier,
  registerCallCompletionNotifier,
  unregisterCallCompletionNotifier,
  fireCallCompletionNotifier,
  registerCallOrchestrator,
  unregisterCallOrchestrator,
  getCallOrchestrator,
} from '../calls/call-state.js';
import type { CallOrchestrator } from '../calls/call-orchestrator.js';

describe('call-state', () => {
  // Clean up notifiers between tests
  beforeEach(() => {
    unregisterCallQuestionNotifier('test-conv');
    unregisterCallCompletionNotifier('test-conv');
    unregisterCallOrchestrator('test-session');
  });

  // ── Question notifiers ────────────────────────────────────────────

  test('registerCallQuestionNotifier + fireCallQuestionNotifier: callback receives args', () => {
    let receivedSessionId = '';
    let receivedQuestion = '';

    registerCallQuestionNotifier('test-conv', (callSessionId, question) => {
      receivedSessionId = callSessionId;
      receivedQuestion = question;
    });

    fireCallQuestionNotifier('test-conv', 'session-123', 'What is the date?');

    expect(receivedSessionId).toBe('session-123');
    expect(receivedQuestion).toBe('What is the date?');
  });

  test('unregisterCallQuestionNotifier: fire after unregister does nothing', () => {
    let called = false;

    registerCallQuestionNotifier('test-conv', () => {
      called = true;
    });

    unregisterCallQuestionNotifier('test-conv');
    fireCallQuestionNotifier('test-conv', 'session-123', 'Some question');

    expect(called).toBe(false);
  });

  test('fireCallQuestionNotifier does nothing when no notifier is registered', () => {
    // Should not throw
    fireCallQuestionNotifier('unregistered-conv', 'session-1', 'question');
  });

  // ── Completion notifiers ──────────────────────────────────────────

  test('registerCallCompletionNotifier + fireCallCompletionNotifier: callback receives callSessionId', () => {
    let receivedSessionId = '';

    registerCallCompletionNotifier('test-conv', (callSessionId) => {
      receivedSessionId = callSessionId;
    });

    fireCallCompletionNotifier('test-conv', 'session-456');

    expect(receivedSessionId).toBe('session-456');
  });

  test('unregisterCallCompletionNotifier: fire after unregister does nothing', () => {
    let called = false;

    registerCallCompletionNotifier('test-conv', () => {
      called = true;
    });

    unregisterCallCompletionNotifier('test-conv');
    fireCallCompletionNotifier('test-conv', 'session-456');

    expect(called).toBe(false);
  });

  test('fireCallCompletionNotifier does nothing when no notifier is registered', () => {
    // Should not throw
    fireCallCompletionNotifier('unregistered-conv', 'session-1');
  });

  // ── Orchestrator registry ─────────────────────────────────────────

  test('registerCallOrchestrator + getCallOrchestrator: retrieves orchestrator', () => {
    const fakeOrchestrator = { id: 'fake-orch' } as unknown as CallOrchestrator;

    registerCallOrchestrator('test-session', fakeOrchestrator);

    const retrieved = getCallOrchestrator('test-session');
    expect(retrieved).toBe(fakeOrchestrator);
  });

  test('unregisterCallOrchestrator: getCallOrchestrator returns undefined after unregister', () => {
    const fakeOrchestrator = { id: 'fake-orch-2' } as unknown as CallOrchestrator;

    registerCallOrchestrator('test-session', fakeOrchestrator);
    unregisterCallOrchestrator('test-session');

    const retrieved = getCallOrchestrator('test-session');
    expect(retrieved).toBeUndefined();
  });

  test('getCallOrchestrator returns undefined for unregistered session', () => {
    const retrieved = getCallOrchestrator('nonexistent-session');
    expect(retrieved).toBeUndefined();
  });

  test('registering a new orchestrator for same session overwrites the previous one', () => {
    const first = { id: 'first' } as unknown as CallOrchestrator;
    const second = { id: 'second' } as unknown as CallOrchestrator;

    registerCallOrchestrator('test-session', first);
    registerCallOrchestrator('test-session', second);

    const retrieved = getCallOrchestrator('test-session');
    expect(retrieved).toBe(second);
  });
});
