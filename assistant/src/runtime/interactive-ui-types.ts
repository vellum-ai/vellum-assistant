/**
 * Types and constants for the interactive UI request primitive.
 *
 * Extracted into a standalone module so that lightweight consumers
 * (CLI commands, route validators) can import types and constants
 * without pulling in the daemon conversation store or surface
 * rendering machinery that `interactive-ui.ts` depends on.
 */

// ── Reserved action IDs ──────────────────────────────────────────────

/**
 * Action IDs reserved for internal use. These are rejected by validation
 * in both the CLI (`parseActions`) and the IPC route (`ui_request` Zod
 * schema) so they never appear as custom button IDs.
 *
 * Two categories of reservation:
 *
 * - **Lifecycle events** (`selection_changed`, `content_changed`,
 *   `state_update`) — intercepted by `handleSurfaceAction` in
 *   conversation-surfaces.ts as non-terminal events (early return
 *   without resolving the pending `ui_request`).
 *
 * - **Cancellation triggers** (`cancel`, `dismiss`) — resolve the
 *   pending `ui_request` as `cancelled` instead of `submitted`.
 */
export const RESERVED_ACTION_IDS = new Set([
  "selection_changed",
  "content_changed",
  "state_update",
  "cancel",
  "dismiss",
]);

// ── Cancellation reasons ─────────────────────────────────────────────

/**
 * Machine-readable reason for a `"cancelled"` outcome.
 *
 * - `"user_dismissed"` — the user explicitly closed/dismissed the surface
 * - `"no_interactive_surface"` — the conversation cannot show interactive UI
 * - `"conversation_not_found"` — the target conversation could not be located
 * - `"resolver_unavailable"` — a resolver was registered but is not currently
 *   available (e.g. the surface transport is disconnected)
 * - `"resolver_error"` — the resolver threw an unexpected error
 */
export type CancellationReason =
  | "user_dismissed"
  | "no_interactive_surface"
  | "conversation_not_found"
  | "resolver_unavailable"
  | "resolver_error";

// ── Request / Result contracts ───────────────────────────────────────

/**
 * Describes a single action button/option presented to the user on the
 * interactive surface.
 */
export interface InteractiveUiAction {
  /** Unique identifier for this action within the request. */
  id: string;
  /** Human-readable label shown on the button/option. */
  label: string;
  /**
   * Optional variant hint for the renderer.
   * - `"primary"` — emphasized / default action
   * - `"danger"` — destructive action (red styling)
   * - `"secondary"` — de-emphasized / cancel-like action
   */
  variant?: "primary" | "danger" | "secondary";
}

/**
 * A request to show an interactive UI surface to the user and await their
 * response.
 */
export interface InteractiveUiRequest {
  /** Conversation this interaction is scoped to. */
  conversationId: string;
  /**
   * Surface type hint for the renderer.
   * - `"confirmation"` — yes/no or approve/deny prompt
   * - `"form"` — structured data entry (v1 placeholder)
   */
  surfaceType: "confirmation" | "form";
  /** Optional title displayed at the top of the surface. */
  title?: string;
  /**
   * Arbitrary payload describing the content of the surface. The shape
   * depends on `surfaceType` — the runtime treats it as opaque and
   * forwards it to the renderer.
   */
  data: Record<string, unknown>;
  /** Actions (buttons) to present. When omitted, the renderer uses its default set. */
  actions?: InteractiveUiAction[];
  /**
   * Maximum time (in milliseconds) to wait for a user response before
   * the request resolves with `status: "timed_out"`. When omitted, the
   * resolver uses its own default timeout (typically 5 minutes).
   */
  timeoutMs?: number;
}

/**
 * The result of an interactive UI request after the user has responded
 * or the request has expired.
 */
export interface InteractiveUiResult {
  /**
   * Terminal status of the interaction.
   * - `"submitted"` — the user selected an action / submitted data
   * - `"cancelled"` — the user explicitly dismissed the surface, or the
   *   surface could not be shown (fail-closed)
   * - `"timed_out"` — the timeout elapsed without a user response
   */
  status: "submitted" | "cancelled" | "timed_out";
  /** The `id` of the action the user selected (when `status === "submitted"`). */
  actionId?: string;
  /** Structured data submitted by the user (for `surfaceType: "form"`). */
  submittedData?: Record<string, unknown>;
  /** Optional human-readable summary of the user's response. */
  summary?: string;
  /** The surface identifier that was shown, for audit/correlation. */
  surfaceId: string;
  /**
   * Machine-readable reason for a `"cancelled"` outcome. Present only
   * when `status === "cancelled"`. Allows callers to distinguish
   * user-initiated dismissals from operational fail-closed outcomes
   * without parsing log messages.
   *
   * Optional for backward compatibility — existing callers that only
   * check `status` continue to work unchanged.
   */
  cancellationReason?: CancellationReason;
  /**
   * Short-lived informational decision token, present when
   * `status === "submitted"` and `surfaceType === "confirmation"`.
   *
   * Non-authoritative — carries metadata about the decision for audit
   * and correlation purposes only. Does not grant any capability.
   * Verification/replay enforcement is out of scope for v1.
   */
  decisionToken?: string;
}
