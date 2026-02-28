import { describe, expect, test } from 'bun:test';

import {
  parseGuardianQuestionPayload,
  resolveGuardianQuestionInstructionMode,
} from '../notifications/guardian-question-mode.js';

describe('guardian-question-mode', () => {
  test('parses pending_question payload as discriminated union', () => {
    const parsed = parseGuardianQuestionPayload({
      requestKind: 'pending_question',
      requestId: 'req-1',
      requestCode: 'A1B2C3',
      questionText: 'What time works?',
      callSessionId: 'call-1',
      activeGuardianRequestCount: 2,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.requestKind).toBe('pending_question');
    if (!parsed || parsed.requestKind !== 'pending_question') return;
    expect(parsed.callSessionId).toBe('call-1');
    expect(parsed.activeGuardianRequestCount).toBe(2);
  });

  test('parses tool_grant_request payload and requires toolName', () => {
    const parsed = parseGuardianQuestionPayload({
      requestKind: 'tool_grant_request',
      requestId: 'req-2',
      requestCode: 'D4E5F6',
      questionText: 'Allow host bash?',
      toolName: 'host_bash',
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.requestKind).toBe('tool_grant_request');
    if (!parsed || parsed.requestKind !== 'tool_grant_request') return;
    expect(parsed.toolName).toBe('host_bash');
  });

  test('rejects invalid pending_question payload missing required fields', () => {
    const parsed = parseGuardianQuestionPayload({
      requestKind: 'pending_question',
      requestId: 'req-3',
      requestCode: 'AAA111',
      questionText: 'Missing call session and count',
    });
    expect(parsed).toBeNull();
  });

  test('resolve mode uses discriminant for valid typed payloads', () => {
    const resolved = resolveGuardianQuestionInstructionMode({
      requestKind: 'pending_question',
      requestId: 'req-1',
      requestCode: 'A1B2C3',
      questionText: 'What time works?',
      callSessionId: 'call-1',
      activeGuardianRequestCount: 2,
    });

    expect(resolved.mode).toBe('answer');
    expect(resolved.requestKind).toBe('pending_question');
    expect(resolved.legacyFallbackUsed).toBe(false);
  });

  test('resolve mode uses legacy fallback when requestKind is missing', () => {
    const resolved = resolveGuardianQuestionInstructionMode({
      requestCode: 'A1B2C3',
      questionText: 'Allow host bash?',
      toolName: 'host_bash',
    });

    expect(resolved.mode).toBe('approval');
    expect(resolved.requestKind).toBeNull();
    expect(resolved.legacyFallbackUsed).toBe(true);
  });
});

