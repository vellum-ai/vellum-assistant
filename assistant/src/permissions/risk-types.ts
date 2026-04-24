/**
 * Shared risk assessment types used by the permission checker.
 *
 * Classifier-internal types (CommandRiskSpec, ArgRule, ArgSchema, etc.) have
 * been migrated to the gateway and removed from the assistant.
 */

import type { AllowlistOption } from "./types.js";

// ── Risk levels ──────────────────────────────────────────────────────────────

/**
 * Risk level for a classified command or tool invocation.
 *
 * - `"low"`: Read-only, no side effects (auto-allow in most policies)
 * - `"medium"`: Writes to filesystem, network access, state changes (confirm)
 * - `"high"`: Destructive, privilege escalation, force ops, arbitrary code exec
 * - `"unknown"`: Not in registry, unrecognized command or arg pattern
 */
export type Risk = "low" | "medium" | "high" | "unknown";

// ── Risk assessment output ───────────────────────────────────────────────────

/** A scope option presented to the user when classifying an unknown command. */
export interface ScopeOption {
  /** Stored in DB if user saves (always regex internally). */
  pattern: string;
  /** Human-readable description shown in UI. */
  label: string;
}

/**
 * A directory scope option emitted by the gateway for filesystem operations.
 * Mirrors `DirectoryScopeOption` in `gateway/src/risk/risk-types.ts`.
 */
export interface DirectoryScopeOption {
  /** Path glob (e.g. "/workspace/scratch/*") or the sentinel "everywhere". */
  scope: string;
  /** Human-readable label (e.g. "In scratch/"). */
  label: string;
}

/**
 * The output of a risk classifier. Tool-agnostic — every classifier
 * (bash, file_write, web_fetch, etc.) produces this same shape.
 */
export interface RiskAssessment {
  /** Computed risk level. */
  riskLevel: Risk;
  /** Human-readable explanation of why this risk level was assigned. */
  reason: string;
  /** Scope options for the "save this classification" UI, narrowest to broadest. */
  scopeOptions: ScopeOption[];
  /** How the risk was determined. */
  matchType: "user_rule" | "registry" | "unknown";
  /**
   * Allowlist options for the permission prompt "always allow" scope ladder.
   * Populated by classifiers that unify risk classification and scope option
   * generation. When present, `generateAllowlistOptions()` returns these
   * directly instead of calling the per-tool strategy function.
   */
  allowlistOptions?: AllowlistOption[];
  /**
   * Directory scope options emitted by the gateway for filesystem operations.
   * Mirrors `directoryScopeOptions` in the gateway's ClassificationResult.
   * Present when the gateway's classifier identified one or more filesystem
   * path arguments and generated a directory-scope ladder for them.
   */
  directoryScopeOptions?: DirectoryScopeOption[];
}
