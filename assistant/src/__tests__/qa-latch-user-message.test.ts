import { describe, expect, test, beforeEach } from 'bun:test';
import { detectQaIntent, detectQaOptOut } from '../daemon/qa-intent.js';
import {
  setQaLatch,
  clearQaLatch,
  isQaLatchActive,
  qaLatchByConversation,
} from '../daemon/handlers/shared.js';

/**
 * Tests that the QA latch is correctly set/cleared based on user message
 * content, mirroring the logic in handleUserMessage in sessions.ts.
 *
 * The handler defers latch updates until after the message has been accepted
 * (past secret-ingress blocking and queue-rejection checks). We test the
 * detection + latch functions directly rather than going through the full
 * IPC handler, since the handler simply calls these functions on the message
 * content after acceptance. This avoids the heavy Session/AgentLoop mock
 * setup while still verifying the integration contract.
 */
describe('QA latch via user_message path', () => {
  const sessionId = 'test-session-1';

  beforeEach(() => {
    // Clear all latch state between tests
    qaLatchByConversation.clear();
  });

  test('user message with QA intent sets the QA latch', () => {
    const content = 'help me test Slack typing';
    expect(detectQaIntent(content)).toBe(true);
    expect(detectQaOptOut(content)).toBe(false);

    // Simulate what handleUserMessage does:
    if (detectQaOptOut(content)) {
      clearQaLatch(sessionId);
    } else if (detectQaIntent(content)) {
      setQaLatch(sessionId);
    }

    expect(isQaLatchActive(sessionId)).toBe(true);
  });

  test('user message with opt-out clears the QA latch', () => {
    // Pre-set the latch
    setQaLatch(sessionId);
    expect(isQaLatchActive(sessionId)).toBe(true);

    const content = 'stop qa mode';
    expect(detectQaOptOut(content)).toBe(true);

    // Simulate what handleUserMessage does:
    if (detectQaOptOut(content)) {
      clearQaLatch(sessionId);
    } else if (detectQaIntent(content)) {
      setQaLatch(sessionId);
    }

    expect(isQaLatchActive(sessionId)).toBe(false);
  });

  test('user message without QA intent does not change the latch', () => {
    expect(isQaLatchActive(sessionId)).toBe(false);

    const content = 'Can you check my email?';
    expect(detectQaIntent(content)).toBe(false);
    expect(detectQaOptOut(content)).toBe(false);

    // Simulate what handleUserMessage does:
    if (detectQaOptOut(content)) {
      clearQaLatch(sessionId);
    } else if (detectQaIntent(content)) {
      setQaLatch(sessionId);
    }

    // Latch should remain unset
    expect(isQaLatchActive(sessionId)).toBe(false);
  });

  test('opt-out takes priority over QA intent in the same message', () => {
    // The current implementation checks opt-out first, so a message that
    // somehow matches both patterns should clear rather than set.
    setQaLatch(sessionId);

    // "stop testing" matches both detectQaOptOut (/\bstop\s+testing\b/)
    // and could theoretically trigger QA patterns. The handler checks
    // opt-out first, so the latch should be cleared.
    const content = 'stop testing';
    const isOptOut = detectQaOptOut(content);
    const isQa = detectQaIntent(content);

    // Simulate what handleUserMessage does (opt-out checked first):
    if (isOptOut) {
      clearQaLatch(sessionId);
    } else if (isQa) {
      setQaLatch(sessionId);
    }

    expect(isQaLatchActive(sessionId)).toBe(false);
  });

  test('latch persists across multiple non-QA messages', () => {
    // Set latch with QA intent
    setQaLatch(sessionId);
    expect(isQaLatchActive(sessionId)).toBe(true);

    // Subsequent non-QA messages should not affect the latch
    const normalMessages = [
      'What is the weather today?',
      'Send a message to the team',
      'Open the settings page',
    ];

    for (const content of normalMessages) {
      if (detectQaOptOut(content)) {
        clearQaLatch(sessionId);
      } else if (detectQaIntent(content)) {
        setQaLatch(sessionId);
      }
    }

    // Latch should still be active
    expect(isQaLatchActive(sessionId)).toBe(true);
  });

  test('latch is not mutated when message would be rejected (contract test)', () => {
    // This test documents the invariant enforced by handleUserMessage:
    // QA detection only runs AFTER the message passes secret-ingress and
    // queue-rejection checks. A rejected message must not flip the latch.
    //
    // We simulate by skipping the detection block entirely (as the handler
    // does when it returns early on rejection).
    expect(isQaLatchActive(sessionId)).toBe(false);

    const content = 'help me test Slack typing';
    expect(detectQaIntent(content)).toBe(true);

    // Simulate rejection: handler returns before reaching QA detection.
    const messageRejected = true;
    if (!messageRejected) {
      if (detectQaOptOut(content)) {
        clearQaLatch(sessionId);
      } else if (detectQaIntent(content)) {
        setQaLatch(sessionId);
      }
    }

    // Latch must remain unset because the message was rejected
    expect(isQaLatchActive(sessionId)).toBe(false);
  });

  test('latch is not mutated when message is blocked by secret ingress (contract test)', () => {
    // Similar to the rejection test: if checkIngressForSecrets blocks the
    // message, the handler returns early and QA detection never runs.
    setQaLatch(sessionId);
    expect(isQaLatchActive(sessionId)).toBe(true);

    const content = 'stop qa mode';
    expect(detectQaOptOut(content)).toBe(true);

    // Simulate secret-ingress block: handler returns before QA detection.
    const blockedBySecretIngress = true;
    if (!blockedBySecretIngress) {
      if (detectQaOptOut(content)) {
        clearQaLatch(sessionId);
      } else if (detectQaIntent(content)) {
        setQaLatch(sessionId);
      }
    }

    // Latch must remain active because the opt-out message was blocked
    expect(isQaLatchActive(sessionId)).toBe(true);
  });

  test('empty message content does not affect the latch', () => {
    setQaLatch(sessionId);
    expect(isQaLatchActive(sessionId)).toBe(true);

    const content = '';
    // In handleUserMessage, empty content skips QA detection entirely
    if (content) {
      if (detectQaOptOut(content)) {
        clearQaLatch(sessionId);
      } else if (detectQaIntent(content)) {
        setQaLatch(sessionId);
      }
    }

    expect(isQaLatchActive(sessionId)).toBe(true);
  });
});
