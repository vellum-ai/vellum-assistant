import { describe, test, expect } from 'bun:test';
import { validateTransition, isTerminalState } from '../calls/call-state-machine.js';
import type { CallStatus } from '../calls/types.js';

describe('call-state-machine', () => {
  // ── Valid transitions ───────────────────────────────────────────────

  describe('valid transitions', () => {
    const validCases: Array<[CallStatus, CallStatus]> = [
      // From initiated
      ['initiated', 'ringing'],
      ['initiated', 'in_progress'],
      ['initiated', 'completed'],
      ['initiated', 'failed'],
      ['initiated', 'cancelled'],

      // From ringing
      ['ringing', 'in_progress'],
      ['ringing', 'completed'],
      ['ringing', 'failed'],
      ['ringing', 'cancelled'],

      // From in_progress
      ['in_progress', 'waiting_on_user'],
      ['in_progress', 'completed'],
      ['in_progress', 'failed'],
      ['in_progress', 'cancelled'],

      // From waiting_on_user
      ['waiting_on_user', 'in_progress'],
      ['waiting_on_user', 'completed'],
      ['waiting_on_user', 'failed'],
      ['waiting_on_user', 'cancelled'],
    ];

    for (const [from, to] of validCases) {
      test(`${from} -> ${to} is valid`, () => {
        const result = validateTransition(from, to);
        expect(result.valid).toBe(true);
        expect(result.reason).toBeUndefined();
      });
    }
  });

  // ── Same-state transitions (no-op, valid) ──────────────────────────

  describe('same-state transitions', () => {
    const allStatuses: CallStatus[] = [
      'initiated', 'ringing', 'in_progress', 'waiting_on_user',
      'completed', 'failed', 'cancelled',
    ];

    for (const status of allStatuses) {
      test(`${status} -> ${status} is valid (no-op)`, () => {
        const result = validateTransition(status, status);
        expect(result.valid).toBe(true);
      });
    }
  });

  // ── Invalid transitions ─────────────────────────────────────────────

  describe('invalid transitions', () => {
    const invalidCases: Array<[CallStatus, CallStatus]> = [
      // Cannot skip backwards
      ['ringing', 'initiated'],
      ['in_progress', 'initiated'],
      ['in_progress', 'ringing'],
      ['waiting_on_user', 'initiated'],
      ['waiting_on_user', 'ringing'],

      // Cannot go from initiated directly to waiting_on_user
      ['initiated', 'waiting_on_user'],

      // Cannot go from ringing to waiting_on_user
      ['ringing', 'waiting_on_user'],
    ];

    for (const [from, to] of invalidCases) {
      test(`${from} -> ${to} is invalid`, () => {
        const result = validateTransition(from, to);
        expect(result.valid).toBe(false);
        expect(result.reason).toBeDefined();
        expect(result.reason!.length).toBeGreaterThan(0);
      });
    }
  });

  // ── Terminal state immutability ─────────────────────────────────────

  describe('terminal state immutability', () => {
    const terminalStates: CallStatus[] = ['completed', 'failed', 'cancelled'];
    const nonTerminalTargets: CallStatus[] = [
      'initiated', 'ringing', 'in_progress', 'waiting_on_user',
    ];

    for (const terminal of terminalStates) {
      for (const target of nonTerminalTargets) {
        test(`${terminal} -> ${target} is rejected (terminal state)`, () => {
          const result = validateTransition(terminal, target);
          expect(result.valid).toBe(false);
          expect(result.reason).toContain('terminal');
        });
      }

      // Also cannot go between terminal states
      for (const otherTerminal of terminalStates) {
        if (otherTerminal === terminal) continue;
        test(`${terminal} -> ${otherTerminal} is rejected (terminal to terminal)`, () => {
          const result = validateTransition(terminal, otherTerminal);
          expect(result.valid).toBe(false);
          expect(result.reason).toContain('terminal');
        });
      }
    }
  });

  // ── isTerminalState ─────────────────────────────────────────────────

  describe('isTerminalState', () => {
    test('completed is terminal', () => {
      expect(isTerminalState('completed')).toBe(true);
    });

    test('failed is terminal', () => {
      expect(isTerminalState('failed')).toBe(true);
    });

    test('cancelled is terminal', () => {
      expect(isTerminalState('cancelled')).toBe(true);
    });

    test('initiated is not terminal', () => {
      expect(isTerminalState('initiated')).toBe(false);
    });

    test('ringing is not terminal', () => {
      expect(isTerminalState('ringing')).toBe(false);
    });

    test('in_progress is not terminal', () => {
      expect(isTerminalState('in_progress')).toBe(false);
    });

    test('waiting_on_user is not terminal', () => {
      expect(isTerminalState('waiting_on_user')).toBe(false);
    });
  });
});
