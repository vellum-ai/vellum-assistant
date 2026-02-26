/**
 * Focused tests for thread candidate validation in the notification decision
 * engine. Validates that:
 * - Valid reuse targets pass validation
 * - Invalid reuse targets are rejected and downgraded to start_new
 * - Candidate context is structurally correct and auditable
 * - The isValidCandidateId guard works as expected
 */

import { describe, expect, test } from 'bun:test';

import { isValidCandidateId } from '../notifications/thread-candidates.js';
import type {
  NotificationChannel,
  ThreadAction,
  ThreadCandidate,
} from '../notifications/types.js';

// -- Helpers -----------------------------------------------------------------

function makeCandidate(overrides?: Partial<ThreadCandidate>): ThreadCandidate {
  return {
    conversationId: 'conv-default',
    title: 'Test Thread',
    updatedAt: Date.now(),
    latestSourceEventName: 'test.event',
    channel: 'vellum' as NotificationChannel,
    ...overrides,
  };
}

// -- Tests -------------------------------------------------------------------

describe('thread candidate validation', () => {
  describe('isValidCandidateId', () => {
    test('returns true when conversationId matches a candidate', () => {
      const candidates = [
        makeCandidate({ conversationId: 'conv-001' }),
        makeCandidate({ conversationId: 'conv-002' }),
      ];

      expect(isValidCandidateId('conv-001', candidates)).toBe(true);
      expect(isValidCandidateId('conv-002', candidates)).toBe(true);
    });

    test('returns false when conversationId does not match any candidate', () => {
      const candidates = [
        makeCandidate({ conversationId: 'conv-001' }),
      ];

      expect(isValidCandidateId('conv-999', candidates)).toBe(false);
    });

    test('returns false for empty candidate list', () => {
      expect(isValidCandidateId('conv-001', [])).toBe(false);
    });

    test('returns false for empty string conversationId', () => {
      const candidates = [
        makeCandidate({ conversationId: 'conv-001' }),
      ];

      expect(isValidCandidateId('', candidates)).toBe(false);
    });

    test('matching is exact (no substring or prefix matching)', () => {
      const candidates = [
        makeCandidate({ conversationId: 'conv-001' }),
      ];

      expect(isValidCandidateId('conv-00', candidates)).toBe(false);
      expect(isValidCandidateId('conv-0011', candidates)).toBe(false);
      expect(isValidCandidateId('CONV-001', candidates)).toBe(false);
    });
  });

  describe('candidate metadata structure', () => {
    test('candidate without guardian context has no optional fields', () => {
      const candidate = makeCandidate();

      expect(candidate.pendingGuardianRequestCount).toBeUndefined();
      expect(candidate.recentCallSessionId).toBeUndefined();
    });

    test('candidate with guardian context includes counts and session IDs', () => {
      const candidate = makeCandidate({
        pendingGuardianRequestCount: 3,
        recentCallSessionId: 'call-123',
      });

      expect(candidate.pendingGuardianRequestCount).toBe(3);
      expect(candidate.recentCallSessionId).toBe('call-123');
    });

    test('candidate with null title is valid', () => {
      const candidate = makeCandidate({ title: null });
      expect(candidate.title).toBeNull();
    });

    test('candidate with null latestSourceEventName is valid', () => {
      const candidate = makeCandidate({ latestSourceEventName: null });
      expect(candidate.latestSourceEventName).toBeNull();
    });
  });

  describe('thread action downgrade semantics', () => {
    test('start_new action does not require a conversationId', () => {
      const action: ThreadAction = { action: 'start_new' };
      expect(action.action).toBe('start_new');
      expect('conversationId' in action).toBe(false);
    });

    test('reuse_existing with valid candidate is accepted', () => {
      const candidates = [
        makeCandidate({ conversationId: 'conv-valid' }),
      ];
      const proposedId = 'conv-valid';

      // Simulate what the engine does: validate, then build the action
      const isValid = isValidCandidateId(proposedId, candidates);
      const action: ThreadAction = isValid
        ? { action: 'reuse_existing', conversationId: proposedId }
        : { action: 'start_new' };

      expect(action.action).toBe('reuse_existing');
      if (action.action === 'reuse_existing') {
        expect(action.conversationId).toBe('conv-valid');
      }
    });

    test('reuse_existing with invalid candidate is downgraded to start_new', () => {
      const candidates = [
        makeCandidate({ conversationId: 'conv-valid' }),
      ];
      const proposedId = 'conv-hacked';

      const isValid = isValidCandidateId(proposedId, candidates);
      const action: ThreadAction = isValid
        ? { action: 'reuse_existing', conversationId: proposedId }
        : { action: 'start_new' };

      expect(action.action).toBe('start_new');
    });

    test('reuse_existing with empty candidate set is downgraded to start_new', () => {
      const candidates: ThreadCandidate[] = [];
      const proposedId = 'conv-any';

      const isValid = isValidCandidateId(proposedId, candidates);
      const action: ThreadAction = isValid
        ? { action: 'reuse_existing', conversationId: proposedId }
        : { action: 'start_new' };

      expect(action.action).toBe('start_new');
    });
  });

  describe('candidate set per channel', () => {
    test('channels without candidates result in empty arrays', () => {
      const candidateMap: Partial<Record<NotificationChannel, ThreadCandidate[]>> = {};

      // When no candidates exist for vellum, the map has no entry
      expect(candidateMap.vellum).toBeUndefined();
    });

    test('candidate set preserves channel association', () => {
      const vellumCandidates = [
        makeCandidate({ conversationId: 'conv-v1', channel: 'vellum' as NotificationChannel }),
      ];
      const telegramCandidates = [
        makeCandidate({ conversationId: 'conv-t1', channel: 'telegram' as NotificationChannel }),
      ];

      const candidateMap: Partial<Record<NotificationChannel, ThreadCandidate[]>> = {
        vellum: vellumCandidates,
        telegram: telegramCandidates,
      };

      // Vellum candidate should not be valid for telegram and vice versa
      expect(isValidCandidateId('conv-v1', candidateMap.vellum ?? [])).toBe(true);
      expect(isValidCandidateId('conv-v1', candidateMap.telegram ?? [])).toBe(false);
      expect(isValidCandidateId('conv-t1', candidateMap.telegram ?? [])).toBe(true);
      expect(isValidCandidateId('conv-t1', candidateMap.vellum ?? [])).toBe(false);
    });
  });
});
