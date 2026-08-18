/**
 * Risk vocabulary shared by the permission checker and the gateway IPC wire
 * types; the classifiers themselves live in the gateway.
 */

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

// ── Classification scope options ─────────────────────────────────────────────

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
