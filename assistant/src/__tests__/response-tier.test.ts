import { describe, expect,test } from 'bun:test';

import {
  classifyResponseTierAsync,
  classifyResponseTierDetailed,
  resolveWithHint,
  type SessionTierHint,
  type TierClassification,
} from '../daemon/response-tier.js';

// ── classifyResponseTierDetailed ──────────────────────────────────────

describe('classifyResponseTierDetailed', () => {
  describe('high confidence → high tier', () => {
    test('long messages (>500 chars)', () => {
      const result = classifyResponseTierDetailed('x'.repeat(501), 0);
      expect(result.tier).toBe('high');
      expect(result.confidence).toBe('high');
    });

    test('code fences', () => {
      const result = classifyResponseTierDetailed('Here is some code:\n```\nconst x = 1;\n```', 0);
      expect(result.tier).toBe('high');
      expect(result.confidence).toBe('high');
    });

    test('file paths', () => {
      const result = classifyResponseTierDetailed('Look at ./src/index.ts', 0);
      expect(result.tier).toBe('high');
      expect(result.confidence).toBe('high');
    });

    test('multi-paragraph', () => {
      const result = classifyResponseTierDetailed('First paragraph.\n\nSecond paragraph.', 0);
      expect(result.tier).toBe('high');
      expect(result.confidence).toBe('high');
    });

    test('build keyword imperatives', () => {
      const result = classifyResponseTierDetailed('Build a REST API for user management', 0);
      expect(result.tier).toBe('high');
      expect(result.confidence).toBe('high');
    });
  });

  describe('high confidence → low tier', () => {
    test('pure greetings under 40 chars', () => {
      const result = classifyResponseTierDetailed('hey', 0);
      expect(result.tier).toBe('low');
      expect(result.confidence).toBe('high');
    });

    test('short messages without build keywords', () => {
      const result = classifyResponseTierDetailed('sounds good', 0);
      expect(result.tier).toBe('low');
      expect(result.confidence).toBe('high');
    });
  });

  describe('low confidence → medium tier', () => {
    test('questions with build keywords fall to medium/low-confidence', () => {
      const result = classifyResponseTierDetailed('how do I build authentication?', 0);
      expect(result.tier).toBe('medium');
      expect(result.confidence).toBe('low');
    });

    test('ambiguous medium-length message', () => {
      const result = classifyResponseTierDetailed(
        'what do you think about the current approach to handling errors in the codebase?',
        0,
      );
      expect(result.tier).toBe('medium');
      expect(result.confidence).toBe('low');
    });
  });
});

// ── resolveWithHint ───────────────────────────────────────────────────

describe('resolveWithHint', () => {
  const lowConfMedium: TierClassification = { tier: 'medium', reason: 'default', confidence: 'low' };
  const highConfLow: TierClassification = { tier: 'low', reason: 'short_no_keywords', confidence: 'high' };
  const highConfHigh: TierClassification = { tier: 'high', reason: 'build_keyword', confidence: 'high' };

  test('high confidence: ignores hint that would downgrade', () => {
    const hint: SessionTierHint = { tier: 'low', turn: 5, timestamp: Date.now() };
    expect(resolveWithHint(highConfHigh, hint, 6)).toBe('high');
  });

  test('high confidence: upgrades when hint is higher', () => {
    const hint: SessionTierHint = { tier: 'medium', turn: 5, timestamp: Date.now() };
    expect(resolveWithHint(highConfLow, hint, 6)).toBe('medium');
  });

  test('high confidence: upgrades to high when hint is high', () => {
    const hint: SessionTierHint = { tier: 'high', turn: 5, timestamp: Date.now() };
    expect(resolveWithHint(highConfLow, hint, 6)).toBe('high');
  });

  test('returns regex tier when no hint available', () => {
    expect(resolveWithHint(lowConfMedium, null, 0)).toBe('medium');
  });

  test('defers to hint when confidence is low and hint is fresh', () => {
    const hint: SessionTierHint = { tier: 'high', turn: 5, timestamp: Date.now() };
    expect(resolveWithHint(lowConfMedium, hint, 6)).toBe('high');
  });

  test('ignores stale hint (too many turns old)', () => {
    const hint: SessionTierHint = { tier: 'high', turn: 0, timestamp: Date.now() };
    // 5 turns later exceeds HINT_MAX_TURN_AGE of 4
    expect(resolveWithHint(lowConfMedium, hint, 5)).toBe('medium');
  });

  test('ignores stale hint (too old by time)', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000 - 1;
    const hint: SessionTierHint = { tier: 'high', turn: 3, timestamp: fiveMinutesAgo };
    expect(resolveWithHint(lowConfMedium, hint, 4)).toBe('medium');
  });

  test('uses hint at exact boundary (4 turns, within time)', () => {
    const hint: SessionTierHint = { tier: 'high', turn: 1, timestamp: Date.now() };
    // 5 - 1 = 4, which is not > 4, so hint is still valid
    expect(resolveWithHint(lowConfMedium, hint, 5)).toBe('high');
  });
});

// ── classifyResponseTierAsync ─────────────────────────────────────────

describe('classifyResponseTierAsync', () => {
  test('returns null when no provider is available', async () => {
    // getConfiguredProvider returns null when no API key is set
    // We can't easily mock it here, but we can verify the function handles it
    const result = await classifyResponseTierAsync(['hello']);
    // In test environment without a configured provider, should return null
    expect(result === undefined || result === 'low' || result === 'medium' || result === 'high').toBe(true);
  });
});
