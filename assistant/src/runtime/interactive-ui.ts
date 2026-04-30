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
 *   - {@link requestInteractiveUi} is the callable entry point. It
 *     looks up the conversation directly from the daemon conversation
 *     store and delegates to {@link showStandaloneSurface}.
 *   - When the conversation is not in memory (client disconnected),
 *     it fails closed by returning a `"cancelled"` result.
 *
 * Concurrency:
 *   - Requests are scoped to a single conversation and identified by a
 *     unique `surfaceId` generated at request time.
 *   - Multiple concurrent requests on different conversations are
 *     independent.
 *
 * Fail-closed guarantee:
 *   - If the conversation is not in memory, `requestInteractiveUi`
 *     returns `{ status: "cancelled" }` immediately.
 *   - If the request times out (per `timeoutMs`), the result status is
 *     `"timed_out"`.
 */

import { findConversation } from "../daemon/conversation-store.js";
import { showStandaloneSurface } from "../daemon/conversation-surfaces.js";
import { getLogger } from "../util/logger.js";
import { mintDecisionToken } from "./decision-token.js";
import type {
  InteractiveUiRequest,
  InteractiveUiResult,
} from "./interactive-ui-types.js";

// Re-export types and constants so existing consumers don't break.
export type {
  CancellationReason,
  InteractiveUiAction,
  InteractiveUiRequest,
  InteractiveUiResult,
} from "./interactive-ui-types.js";

const log = getLogger("interactive-ui");

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

  // Look up the conversation directly. Interactive UI requires the
  // conversation to be in memory (client connected via SSE). If not
  // found, fail closed — hydrating from storage would be pointless
  // since the hydrated conversation has no connected client.
  const conversation = findConversation(request.conversationId);

  if (!conversation) {
    log.warn(
      {
        conversationId: request.conversationId,
        surfaceType: request.surfaceType,
      },
      "interactive-ui: conversation not in memory (client not connected); failing closed",
    );
    const failResult: InteractiveUiResult = {
      status: "cancelled",
      surfaceId,
      cancellationReason: "conversation_not_found",
    };
    emitAuditLog(request, failResult);
    return failResult;
  }

  try {
    const standaloneSurfaceId = `ui-standalone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const resolverResult = await showStandaloneSurface(
      conversation,
      request,
      standaloneSurfaceId,
    );
    // Ensure the surfaceId is consistent — showStandaloneSurface may or
    // may not populate it, but the contract guarantees it is always present.
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
      cancellationReason: "resolver_error",
    };
    emitAuditLog(request, failResult);
    return failResult;
  }
}
