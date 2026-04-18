/**
 * Generic UI interaction request primitive.
 *
 * Provides a conversation-scoped mechanism for daemon-side code (skills,
 * IPC handlers, CLI wrappers) to present an interactive UI surface to the
 * user and await their response. This is intentionally decoupled from the
 * confirmation_request / guardian approval pipeline — it serves a different
 * purpose (ad-hoc UI prompts driven by skills or CLI commands, not
 * tool-approval gates).
 *
 * Architecture:
 *   - Typed {@link InteractiveUiRequest} / {@link InteractiveUiResult}
 *     contracts define the wire shape for callers and resolvers.
 *   - A module-level resolver ({@link registerInteractiveUiResolver}) is
 *     installed once at daemon startup, following the same pattern as
 *     {@link registerDefaultWakeResolver} in `runtime/agent-wake.ts`.
 *   - {@link requestInteractiveUi} is the callable entry point. It
 *     delegates to the registered resolver; when no resolver is present
 *     (e.g. headless environments, test harnesses that don't install
 *     one), it fails closed by returning a `"cancelled"` result.
 *
 * Concurrency:
 *   - Requests are scoped to a single conversation and identified by a
 *     unique `surfaceId` generated at request time.
 *   - Multiple concurrent requests on different conversations are
 *     independent.
 *   - The resolver is responsible for lifecycle management of the
 *     underlying surface (show, await action/timeout, dismiss).
 *
 * Fail-closed guarantee:
 *   - If no resolver is registered, `requestInteractiveUi` returns
 *     `{ status: "cancelled" }` immediately.
 *   - If the request times out (per `timeoutMs`), the result status is
 *     `"timed_out"`.
 */

import { getLogger } from "../util/logger.js";
import { mintDecisionToken } from "./decision-token.js";

const log = getLogger("interactive-ui");

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
   * Short-lived informational decision token, present when
   * `status === "submitted"` and `surfaceType === "confirmation"`.
   *
   * Non-authoritative — carries metadata about the decision for audit
   * and correlation purposes only. Does not grant any capability.
   * Verification/replay enforcement is out of scope for v1.
   */
  decisionToken?: string;
}

// ── Resolver type ────────────────────────────────────────────────────

/**
 * A function that presents an interactive UI surface and resolves when
 * the user responds or the timeout elapses.
 */
export type InteractiveUiResolver = (
  request: InteractiveUiRequest,
) => Promise<InteractiveUiResult>;

// ── Module-level resolver registration ───────────────────────────────
//
// Same pattern as `runtime/agent-wake.ts`: a module-level default
// resolver that the daemon installs once at startup. Callers that use
// `requestInteractiveUi()` get the daemon-wired resolver automatically.
// Tests can register a mock resolver and reset via the test-only helper.

let _resolver: InteractiveUiResolver | null = null;

/**
 * Install the process-wide interactive UI resolver. Called once at
 * daemon startup (see `DaemonServer.start()`) with a function that
 * knows how to show a surface on a live conversation and await the
 * user's response.
 *
 * Calling this more than once replaces the prior resolver — the daemon
 * startup path should call it exactly once.
 */
export function registerInteractiveUiResolver(
  resolver: InteractiveUiResolver,
): void {
  _resolver = resolver;
}

/**
 * Reset the process-wide resolver. Test-only.
 *
 * @internal
 */
export function resetInteractiveUiResolverForTests(): void {
  _resolver = null;
}

// ── Surface ID generation ────────────────────────────────────────────

let _surfaceIdCounter = 0;

function generateSurfaceId(): string {
  _surfaceIdCounter++;
  return `ui-interaction-${Date.now()}-${_surfaceIdCounter}`;
}

/**
 * Reset the surface ID counter. Test-only.
 *
 * @internal
 */
export function resetSurfaceIdCounterForTests(): void {
  _surfaceIdCounter = 0;
}

// ── Audit logging ────────────────────────────────────────────────────

/**
 * Emit a structured audit log entry for an interactive UI decision.
 * Keyed by conversation/surface/request IDs so downstream consumers
 * can correlate decisions across the system.
 */
function emitAuditLog(
  request: InteractiveUiRequest,
  result: InteractiveUiResult,
): void {
  log.info(
    {
      event: "interactive_ui_decision",
      conversationId: request.conversationId,
      surfaceId: result.surfaceId,
      surfaceType: request.surfaceType,
      status: result.status,
      actionId: result.actionId,
      timestamp: new Date().toISOString(),
    },
    "interactive-ui: decision recorded",
  );
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Present an interactive UI surface to the user and await their
 * response.
 *
 * Fails closed: when no resolver is registered (headless, tests without
 * setup), returns `{ status: "cancelled", surfaceId }` immediately.
 *
 * When the surface type is `"confirmation"` and the user selects the
 * `"confirm"` action, a short-lived informational decision token is
 * minted and attached to the result. Deny actions and other non-confirm
 * outcomes do not receive a token. If token minting fails, the user's
 * decision is still returned as `submitted` (the token is best-effort).
 * The token is non-authoritative — see {@link mintDecisionToken} for
 * details.
 *
 * Structured audit logs are emitted for all terminal outcomes
 * (`submitted`, `cancelled`, `timed_out`).
 *
 * @param request - The interaction request describing the surface.
 * @returns The user's response or a fail-closed cancellation.
 */
export async function requestInteractiveUi(
  request: InteractiveUiRequest,
): Promise<InteractiveUiResult> {
  const surfaceId = generateSurfaceId();

  if (!_resolver) {
    log.warn(
      {
        conversationId: request.conversationId,
        surfaceType: request.surfaceType,
      },
      "interactive-ui: no resolver registered; failing closed",
    );
    const failResult: InteractiveUiResult = {
      status: "cancelled",
      surfaceId,
    };
    emitAuditLog(request, failResult);
    return failResult;
  }

  try {
    const resolverResult = await _resolver(request);
    // Ensure the surfaceId is consistent — the resolver may or may not
    // populate it, but the contract guarantees it is always present.
    const finalSurfaceId = resolverResult.surfaceId || surfaceId;

    const result: InteractiveUiResult = {
      ...resolverResult,
      surfaceId: finalSurfaceId,
    };

    // Mint an informational decision token only for affirmative
    // confirmation actions. The token is short-lived (5 minutes) and
    // non-authoritative in v1. Deny/cancel/timeout do not receive tokens.
    if (
      result.status === "submitted" &&
      request.surfaceType === "confirmation" &&
      result.actionId === "confirm"
    ) {
      try {
        result.decisionToken = mintDecisionToken({
          conversationId: request.conversationId,
          surfaceId: finalSurfaceId,
          action: result.actionId,
        });
      } catch (tokenErr) {
        log.warn(
          { err: tokenErr, surfaceId: finalSurfaceId },
          "interactive-ui: failed to mint decision token; continuing without it",
        );
      }
    }

    emitAuditLog(request, result);
    return result;
  } catch (err) {
    log.error(
      {
        err,
        conversationId: request.conversationId,
        surfaceType: request.surfaceType,
      },
      "interactive-ui: resolver threw; failing closed",
    );
    const failResult: InteractiveUiResult = {
      status: "cancelled",
      surfaceId,
    };
    emitAuditLog(request, failResult);
    return failResult;
  }
}
