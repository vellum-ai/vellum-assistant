/**
 * A2A Scope Policy Engine — maps actions to required scopes and evaluates
 * whether a connection's granted scopes cover the requested action.
 *
 * Pure functions with no I/O or side effects. The engine is the single
 * evaluation point for scope-based access control on A2A connections.
 *
 * Default deny: if an action has no mapping in the policy table, it is
 * denied. This is the fail-closed default — no scope can authorize an
 * unmapped action.
 */

import { isValidScopeId } from './a2a-scope-catalog.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Actions that can be evaluated against connection scopes. */
export type A2AScopedAction =
  | 'sendMessage'
  | 'receiveMessage'
  | 'readAvailability'
  | 'createEvent'
  | 'readProfile'
  | 'executeRequest';

export type ScopeEvaluationResult =
  | { allowed: true }
  | { allowed: false; reason: string };

// ---------------------------------------------------------------------------
// Action-to-scope mapping
// ---------------------------------------------------------------------------

/**
 * Static mapping from actions to the scope ID required to perform them.
 * Actions not in this map are denied by default.
 */
const ACTION_SCOPE_MAP: Record<A2AScopedAction, string> = {
  sendMessage: 'message',
  receiveMessage: 'message',
  readAvailability: 'read_availability',
  createEvent: 'create_events',
  readProfile: 'read_profile',
  executeRequest: 'execute_requests',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a set of granted scopes covers a requested action.
 *
 * Pure function — no I/O, no side effects. Takes the connection's scope
 * array and the action being attempted, returns allow/deny with reason.
 */
export function evaluateScope(
  connectionScopes: string[],
  action: A2AScopedAction,
): ScopeEvaluationResult {
  const requiredScope = ACTION_SCOPE_MAP[action];

  if (!requiredScope) {
    return {
      allowed: false,
      reason: `No scope mapping exists for action "${action}" — denied by default`,
    };
  }

  if (!connectionScopes.includes(requiredScope)) {
    return {
      allowed: false,
      reason: `Action "${action}" requires scope "${requiredScope}" which is not granted on this connection`,
    };
  }

  return { allowed: true };
}

/**
 * Get the required scope ID for an action, or undefined if the action
 * has no mapping (and would be denied by default).
 */
export function getRequiredScopeForAction(action: string): string | undefined {
  return ACTION_SCOPE_MAP[action as A2AScopedAction];
}

/**
 * Get the required scope ID for a tool name.
 *
 * Maps registered tool names to their required A2A scopes. Tools not in
 * this map fall through to the existing peer_assistant deny-all gate —
 * no scope can authorize them.
 *
 * This is deliberately conservative: only tools that have explicit scope
 * coverage are listed. Everything else is denied.
 */
export function getRequiredScopeForTool(_toolName: string): string | undefined {
  // v1: no individual tool-to-scope mappings yet.
  // The tool execution gate in tool-approval-handler checks this function
  // to decide whether a peer_assistant tool invocation is scope-covered.
  // Returning undefined means "no scope can authorize this tool" — the
  // existing deny-all gate applies.
  //
  // Future milestones will add mappings here as scoped tool categories
  // are defined (e.g., calendar tools -> read_availability/create_events).
  return undefined;
}

/**
 * Check whether a scope ID from the catalog is valid. Re-exported for
 * convenience so consumers don't need to import from two modules.
 */
export { isValidScopeId };
