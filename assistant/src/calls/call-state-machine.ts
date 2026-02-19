/**
 * Call state machine — defines allowed status transitions and validates
 * all state changes in a single place.
 *
 * Terminal states (completed, failed, cancelled) are immutable: no further
 * transitions are permitted once a call reaches one of these states.
 */

import type { CallStatus } from './types.js';

// ── Transition table ─────────────────────────────────────────────────

/**
 * Maps each call status to the set of statuses it may transition to.
 * Terminal states map to an empty set.
 */
const ALLOWED_TRANSITIONS: Record<CallStatus, Set<CallStatus>> = {
  initiated: new Set<CallStatus>(['ringing', 'in_progress', 'completed', 'failed', 'cancelled']),
  ringing: new Set<CallStatus>(['in_progress', 'completed', 'failed', 'cancelled']),
  in_progress: new Set<CallStatus>(['waiting_on_user', 'completed', 'failed', 'cancelled']),
  waiting_on_user: new Set<CallStatus>(['in_progress', 'completed', 'failed', 'cancelled']),
  // Terminal states — no further transitions allowed
  completed: new Set<CallStatus>(),
  failed: new Set<CallStatus>(),
  cancelled: new Set<CallStatus>(),
};

const TERMINAL_STATES: Set<CallStatus> = new Set(['completed', 'failed', 'cancelled']);

// ── Public API ───────────────────────────────────────────────────────

export interface TransitionResult {
  valid: boolean;
  reason?: string;
}

/**
 * Check whether a transition from `current` to `next` is allowed.
 */
export function validateTransition(current: CallStatus, next: CallStatus): TransitionResult {
  if (current === next) {
    return { valid: true };
  }

  if (isTerminalState(current)) {
    return {
      valid: false,
      reason: `Cannot transition from terminal state '${current}'`,
    };
  }

  const allowed = ALLOWED_TRANSITIONS[current];
  if (!allowed || !allowed.has(next)) {
    return {
      valid: false,
      reason: `Invalid transition from '${current}' to '${next}'`,
    };
  }

  return { valid: true };
}

/**
 * Returns true if the given status is a terminal (immutable) state.
 */
export function isTerminalState(status: CallStatus): boolean {
  return TERMINAL_STATES.has(status);
}
