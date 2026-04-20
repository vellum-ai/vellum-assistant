import type { PolicyContext, TrustRule } from "./types.js";

export interface StarterBundleRule {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: "allow";
  priority: number;
}

export interface AcceptStarterBundleResult {
  accepted: boolean;
  rulesAdded: number;
  alreadyAccepted: boolean;
}

/**
 * Backend interface for trust rule storage and retrieval.
 *
 * The file-based implementation reads/writes `~/.vellum/protected/trust.json`.
 * A future gateway-backed implementation will proxy these operations through
 * the gateway HTTP API for containerized deployments.
 */
export interface TrustStoreBackend {
  /** Return a copy of all trust rules (file-based rules + defaults). */
  getAllRules(): TrustRule[];

  /**
   * Find the highest-priority rule that matches any of the command candidates.
   * Rules are pre-sorted by priority descending, so the first match wins.
   */
  findHighestPriorityRule(
    tool: string,
    commands: string[],
    scope: string,
    ctx?: PolicyContext,
  ): TrustRule | null;

  /** Find the first matching allow rule for a tool/command/scope. */
  findMatchingRule(
    tool: string,
    command: string,
    scope: string,
  ): TrustRule | null;

  /** Find the first matching deny rule for a tool/command/scope. */
  findDenyRule(tool: string, command: string, scope: string): TrustRule | null;

  /** Add a new trust rule and persist it. */
  addRule(
    tool: string,
    pattern: string,
    scope: string,
    decision?: "allow" | "deny" | "ask",
    priority?: number,
    options?: {
      executionTarget?: string;
    },
  ): TrustRule;

  /** Update an existing trust rule by ID and persist it. */
  updateRule(
    id: string,
    updates: {
      tool?: string;
      pattern?: string;
      scope?: string;
      decision?: "allow" | "deny" | "ask";
      priority?: number;
    },
  ): TrustRule;

  /** Remove a trust rule by ID. Returns true if the rule existed. */
  removeRule(id: string): boolean;

  /** Clear all user-created rules (default rules are re-backfilled). */
  clearAllRules(): void;

  /** Accept the starter approval bundle, seeding low-risk allow rules. */
  acceptStarterBundle(): AcceptStarterBundleResult;

  /** Whether the user has previously accepted the starter bundle. */
  isStarterBundleAccepted(): boolean;

  /** Register a callback to be invoked whenever trust rules change. */
  onRulesChanged(listener: () => void): void;

  /** Invalidate in-memory caches, forcing a re-read from the backing store. */
  clearCache(): void;

  /**
   * Check whether a minimatch pattern matches a candidate string.
   * Reuses the compiled pattern cache from trust rule evaluation.
   */
  patternMatchesCandidate(pattern: string, candidate: string): boolean;

  /** Returns the starter bundle rule definitions. */
  getStarterBundleRules(): StarterBundleRule[];
}
