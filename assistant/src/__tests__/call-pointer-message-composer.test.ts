import { describe, expect, test } from 'bun:test';

import { mock } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  buildPointerGenerationPrompt,
  composeCallPointerMessageGenerative,
  getPointerFallbackMessage,
  includesRequiredFacts,
  type CallPointerMessageContext,
} from '../calls/call-pointer-message-composer.js';

// ---------------------------------------------------------------------------
// Deterministic fallback templates
// ---------------------------------------------------------------------------

describe('getPointerFallbackMessage', () => {
  test('started without verification code', () => {
    const msg = getPointerFallbackMessage({ scenario: 'started', phoneNumber: '+15551234567' });
    expect(msg).toContain('Call to +15551234567 started');
    expect(msg).not.toContain('Verification code');
  });

  test('started with verification code', () => {
    const msg = getPointerFallbackMessage({
      scenario: 'started',
      phoneNumber: '+15551234567',
      verificationCode: '1234',
    });
    expect(msg).toContain('Verification code: 1234');
    expect(msg).toContain('+15551234567');
  });

  test('completed without duration', () => {
    const msg = getPointerFallbackMessage({ scenario: 'completed', phoneNumber: '+15559876543' });
    expect(msg).toContain('completed');
    expect(msg).toContain('+15559876543');
  });

  test('completed with duration', () => {
    const msg = getPointerFallbackMessage({
      scenario: 'completed',
      phoneNumber: '+15559876543',
      duration: '5m 30s',
    });
    expect(msg).toContain('completed (5m 30s)');
  });

  test('failed without reason', () => {
    const msg = getPointerFallbackMessage({ scenario: 'failed', phoneNumber: '+15559876543' });
    expect(msg).toContain('failed');
    expect(msg).toContain('+15559876543');
  });

  test('failed with reason', () => {
    const msg = getPointerFallbackMessage({
      scenario: 'failed',
      phoneNumber: '+15559876543',
      reason: 'no answer',
    });
    expect(msg).toContain('failed: no answer');
  });

  test('guardian_verification_succeeded defaults to voice channel', () => {
    const msg = getPointerFallbackMessage({
      scenario: 'guardian_verification_succeeded',
      phoneNumber: '+15559876543',
    });
    expect(msg).toContain('Guardian verification (voice)');
    expect(msg).toContain('succeeded');
  });

  test('guardian_verification_succeeded with custom channel', () => {
    const msg = getPointerFallbackMessage({
      scenario: 'guardian_verification_succeeded',
      phoneNumber: '+15559876543',
      channel: 'sms',
    });
    expect(msg).toContain('Guardian verification (sms)');
  });

  test('guardian_verification_failed without reason', () => {
    const msg = getPointerFallbackMessage({
      scenario: 'guardian_verification_failed',
      phoneNumber: '+15559876543',
    });
    expect(msg).toContain('Guardian verification');
    expect(msg).toContain('failed');
  });

  test('guardian_verification_failed with reason', () => {
    const msg = getPointerFallbackMessage({
      scenario: 'guardian_verification_failed',
      phoneNumber: '+15559876543',
      reason: 'Max attempts exceeded',
    });
    expect(msg).toContain('failed: Max attempts exceeded');
  });
});

// ---------------------------------------------------------------------------
// Required facts validation
// ---------------------------------------------------------------------------

describe('includesRequiredFacts', () => {
  test('returns true when no required facts', () => {
    expect(includesRequiredFacts('any text', undefined)).toBe(true);
    expect(includesRequiredFacts('any text', [])).toBe(true);
  });

  test('returns true when all facts present', () => {
    expect(includesRequiredFacts('Call to +15551234567 completed (2m).', ['+15551234567', '2m'])).toBe(true);
  });

  test('returns false when a fact is missing', () => {
    expect(includesRequiredFacts('Call completed.', ['+15551234567'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

describe('buildPointerGenerationPrompt', () => {
  test('includes context JSON and fallback message', () => {
    const ctx: CallPointerMessageContext = { scenario: 'started', phoneNumber: '+15551234567' };
    const prompt = buildPointerGenerationPrompt(ctx, 'Fallback text', undefined);
    expect(prompt).toContain(JSON.stringify(ctx));
    expect(prompt).toContain('Fallback text');
  });

  test('includes required facts clause when provided', () => {
    const ctx: CallPointerMessageContext = { scenario: 'completed', phoneNumber: '+15559876543', duration: '3m' };
    const prompt = buildPointerGenerationPrompt(ctx, 'Fallback', ['+15559876543', '3m']);
    expect(prompt).toContain('Required facts to include');
    expect(prompt).toContain('+15559876543');
    expect(prompt).toContain('3m');
  });
});

// ---------------------------------------------------------------------------
// Generative composition (test env falls back to deterministic)
// ---------------------------------------------------------------------------

describe('composeCallPointerMessageGenerative', () => {
  test('returns fallback in test environment regardless of generator', async () => {
    const generator = async () => 'LLM-generated copy';
    const ctx: CallPointerMessageContext = { scenario: 'started', phoneNumber: '+15551234567' };
    const result = await composeCallPointerMessageGenerative(ctx, {}, generator);
    // NODE_ENV is 'test' during bun test
    expect(result).toContain('Call to +15551234567 started');
  });

  test('returns fallback when no generator provided', async () => {
    const ctx: CallPointerMessageContext = { scenario: 'failed', phoneNumber: '+15559876543', reason: 'busy' };
    const result = await composeCallPointerMessageGenerative(ctx);
    expect(result).toContain('failed: busy');
  });

  test('uses custom fallbackText when provided', async () => {
    const ctx: CallPointerMessageContext = { scenario: 'completed', phoneNumber: '+15559876543' };
    const result = await composeCallPointerMessageGenerative(ctx, { fallbackText: 'Custom fallback' });
    expect(result).toBe('Custom fallback');
  });
});
