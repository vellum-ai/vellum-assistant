/**
 * Types for the data-driven command risk classifier.
 *
 * All types are JSON-serializable — no native RegExp, no function references.
 * Regex patterns are stored as strings (use `String.raw` for ergonomics in TS).
 * This constraint exists because the registry will eventually be persisted to a
 * DB with per-user/per-org overrides that need to round-trip cleanly.
 *
 * @see /docs/bash-risk-classifier-design.md
 */

import { RiskLevel } from "./types.js";

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

/**
 * Risk levels that can be assigned to commands in the registry.
 * Excludes "unknown" — that's a classifier output, not a registry value.
 */
export type RegistryRisk = "low" | "medium" | "high";

// ── Risk assessment output ───────────────────────────────────────────────────

/** A scope option presented to the user when classifying an unknown command. */
export interface ScopeOption {
  /** Stored in DB if user saves (always regex internally). */
  pattern: string;
  /** Human-readable description shown in UI. */
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
}

// ── Classifier interface ─────────────────────────────────────────────────────

/**
 * Generic risk classifier interface. Each tool type (bash, file_write, etc.)
 * implements this with a tool-specific input type.
 */
export interface RiskClassifier<TInput> {
  classify(input: TInput): Promise<RiskAssessment>;
}

// ── Bash classifier input ────────────────────────────────────────────────────

/** Input to the bash risk classifier. */
export interface BashClassifierInput {
  /** The raw command string. */
  command: string;
  /** Which tool is being invoked. */
  toolName: "bash" | "host_bash";
  /** Working directory (for path resolution in arg rules). */
  workingDir?: string;
}

// ── Command registry types ───────────────────────────────────────────────────

/**
 * A single arg-level risk rule within a command spec.
 *
 * Evaluated per arg token. If `flags` is set, the rule only fires when the
 * arg matches one of those flags. If `valuePattern` is set, the arg (or the
 * flag's consumed value) must match the regex.
 */
export interface ArgRule {
  /**
   * Stable ID for DB references, partial overrides, and audit trails.
   * Convention: `"command:descriptor"` (e.g. `"curl:upload-file"`, `"rm:recursive-force"`).
   */
  id: string;
  /**
   * Flag(s) that trigger this rule. Omit for positional/any-arg matching.
   * Combined short flags are listed as literals (e.g. `"-rf"`, `"-fr"`).
   */
  flags?: string[];
  /**
   * Regex string matched against the arg value. Omit if flag presence alone
   * triggers the rule. Stored as a string (not a native RegExp) for JSON
   * serialization.
   */
  valuePattern?: string;
  /** Risk level when this rule fires. */
  risk: RegistryRisk;
  /** Human-readable reason (shown in permission prompt). */
  reason: string;
}

/**
 * Risk specification for a single command (or subcommand).
 *
 * The registry is a `Record<string, CommandRiskSpec>` mapping program names
 * to their specs. Subcommands nest recursively.
 */
export interface CommandRiskSpec {
  /** Base risk when no arg rules match. */
  baseRisk: RegistryRisk;
  /**
   * Subcommand-level overrides. Keys are subcommand names
   * (e.g. `{ push: { baseRisk: "medium", ... } }` under `git`).
   * Subcommands can nest further (e.g. `git stash drop`).
   */
  subcommands?: Record<string, CommandRiskSpec>;
  /** Arg-level rules, evaluated per arg. First match per arg wins. */
  argRules?: ArgRule[];
  /**
   * Is this a wrapper command? (sudo, env, nice, etc.)
   * When true, the classifier unwraps to find the inner command and
   * takes the max of the wrapper's baseRisk and the inner command's risk.
   */
  isWrapper?: boolean;
  /**
   * Flags that put a wrapper into a non-exec mode (e.g. command -v, env -0).
   * When the first arg matches a non-exec flag, skip unwrapping and classify
   * the wrapper standalone against its own arg rules.
   */
  nonExecFlags?: string[];
  /**
   * Does this command have non-standard syntax where intermediate scope
   * options would be confusing? (find, xargs, awk, etc.)
   * When true, the scope ladder only offers exact match and command-level wildcard.
   */
  complexSyntax?: boolean;
  /** Human-readable reason for the base risk (shown when no arg rule matches). */
  reason?: string;
}

// ── User rule types ──────────────────────────────────────────────────────────

/**
 * A user-created risk classification rule.
 *
 * Created via the scope ladder UI (from permission prompts) or manually
 * in settings. Stored in the user's DB.
 */
export interface UserRule {
  /** Auto-generated unique ID. */
  id: string;
  /** Regex pattern (converted from glob at creation time). */
  pattern: string;
  /** User-assigned risk level. */
  risk: RegistryRisk;
  /** Human-readable label (shown in settings UI). */
  label: string;
  /** ISO 8601 timestamp of when the rule was created. */
  createdAt: string;
  /** How the rule was created. */
  source: "scope_ladder" | "manual";
}

// ── Risk → RiskLevel mapping ─────────────────────────────────────────────────

/**
 * Map a classifier `Risk` value to the permission system's `RiskLevel` enum.
 *
 * `"unknown"` maps to `RiskLevel.Medium` — matching the existing checker.ts
 * behavior where unrecognized commands are treated as medium-risk.
 */
export function riskToRiskLevel(risk: Risk): RiskLevel {
  switch (risk) {
    case "low":
      return RiskLevel.Low;
    case "medium":
      return RiskLevel.Medium;
    case "high":
      return RiskLevel.High;
    case "unknown":
      return RiskLevel.Medium;
  }
}
