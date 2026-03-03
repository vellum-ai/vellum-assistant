/**
 * A2A Scope Catalog — declared registry of all recognized scope IDs.
 *
 * Scopes control what a peer assistant is allowed to do on a per-connection
 * basis. The catalog is the canonical source of truth for scope metadata;
 * undeclared scope IDs are rejected at the store layer when guardians
 * configure connection scopes.
 *
 * Pattern follows the feature flag registry: a fixed catalog with typed
 * entries, validated at write time, queried at read time.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScopeRiskLevel = 'low' | 'medium' | 'high';

export interface ScopeDefinition {
  /** Unique scope identifier (lowercase, underscore-separated). */
  id: string;
  /** Human-readable label for UI display. */
  label: string;
  /** Description of what the scope allows. */
  description: string;
  /** Risk classification — informs guardian decision-making in the UI. */
  riskLevel: ScopeRiskLevel;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const SCOPE_DEFINITIONS: readonly ScopeDefinition[] = [
  {
    id: 'message',
    label: 'Send/receive messages',
    description: 'Allow sending and receiving text messages over the A2A connection.',
    riskLevel: 'low',
  },
  {
    id: 'read_availability',
    label: 'Read calendar availability',
    description: 'Allow reading calendar free/busy information and time slot availability.',
    riskLevel: 'low',
  },
  {
    id: 'create_events',
    label: 'Create calendar events',
    description: 'Allow creating calendar events (meetings, reminders). The assistant may still require guardian confirmation.',
    riskLevel: 'medium',
  },
  {
    id: 'read_profile',
    label: 'Read basic profile',
    description: 'Allow reading non-sensitive profile information: display name, timezone, preferred language.',
    riskLevel: 'low',
  },
  {
    id: 'execute_requests',
    label: 'Execute structured requests',
    description: 'Allow executing structured A2A requests (typed action/response patterns beyond simple messaging).',
    riskLevel: 'high',
  },
] as const;

/** Set of all valid scope IDs for O(1) membership checks. */
const VALID_SCOPE_IDS = new Set(SCOPE_DEFINITIONS.map((s) => s.id));

/** Map from scope ID to definition for O(1) metadata lookups. */
const SCOPE_BY_ID = new Map(SCOPE_DEFINITIONS.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a scope ID is declared in the catalog.
 */
export function isValidScopeId(scopeId: string): boolean {
  return VALID_SCOPE_IDS.has(scopeId);
}

/**
 * Validate an array of scope IDs against the catalog.
 * Returns the list of unrecognized scope IDs, or an empty array if all are valid.
 */
export function validateScopeIds(scopeIds: string[]): { valid: true } | { valid: false; unrecognized: string[] } {
  const unrecognized = scopeIds.filter((id) => !VALID_SCOPE_IDS.has(id));
  if (unrecognized.length > 0) {
    return { valid: false, unrecognized };
  }
  return { valid: true };
}

/**
 * Get the metadata for a scope ID. Returns undefined for undeclared scopes.
 */
export function getScopeDefinition(scopeId: string): ScopeDefinition | undefined {
  return SCOPE_BY_ID.get(scopeId);
}

/**
 * Return all declared scope definitions.
 */
export function getAllScopeDefinitions(): readonly ScopeDefinition[] {
  return SCOPE_DEFINITIONS;
}

/**
 * Return all valid scope IDs as a readonly set.
 */
export function getValidScopeIds(): ReadonlySet<string> {
  return VALID_SCOPE_IDS;
}
