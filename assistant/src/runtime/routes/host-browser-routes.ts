/**
 * Route handler for host browser result submissions.
 *
 * Resolves pending host browser proxy requests by requestId when the desktop
 * client returns CDP results via HTTP.
 */
import { z } from "zod";

import {
  markTargetInvalidated,
  publishCdpEvent,
} from "../../browser-session/events.js";
import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

/**
 * Result of attempting to resolve a host browser result frame. Used by both
 * the HTTP endpoint and the WS relay path so they share the same validation
 * and resolution semantics.
 *
 * Success → the pending interaction was consumed and the conversation was
 * notified.
 *
 * Error variants mirror the HTTP status codes the `/v1/host-browser-result`
 * endpoint returns, so the caller can log/translate them consistently.
 */
export type HostBrowserResultResolution =
  | { ok: true }
  | {
      ok: false;
      code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT";
      status: 400 | 404 | 409;
      message: string;
    };

/**
 * Shared resolver used by both the HTTP route handler and the WS
 * `host_browser_result` frame handler. Looks up the pending interaction
 * by requestId, validates its kind, and forwards the response to the
 * owning conversation.
 *
 * This function does NOT perform auth — callers are expected to have
 * already authenticated the caller (the HTTP route uses
 * `requireBoundGuardian`, the WS path relies on the JWT check performed
 * at WebSocket upgrade time).
 */
export function resolveHostBrowserResultByRequestId(frame: {
  requestId?: unknown;
  content?: unknown;
  isError?: unknown;
}): HostBrowserResultResolution {
  const { requestId, content, isError } = frame;

  if (!requestId || typeof requestId !== "string") {
    return {
      ok: false,
      code: "BAD_REQUEST",
      status: 400,
      message: "requestId is required",
    };
  }

  // Peek first (non-destructive) so we can validate the interaction kind
  // without accidentally consuming a confirmation or secret interaction.
  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    return {
      ok: false,
      code: "NOT_FOUND",
      status: 404,
      message: "No pending interaction found for this requestId",
    };
  }

  if (peeked.kind !== "host_browser") {
    return {
      ok: false,
      code: "CONFLICT",
      status: 409,
      message: `Pending interaction is of kind "${peeked.kind}", expected "host_browser"`,
    };
  }

  // Validation passed — consume the pending interaction.
  const interaction = pendingInteractions.resolve(requestId)!;

  const normalizedContent = typeof content === "string" ? content : "";
  const normalizedIsError = typeof isError === "boolean" ? isError : false;

  // The host_browser kind always has a conversation attached at register time
  // (HostBrowserProxy.request wires it through), so this guard exists so a
  // future refactor of pending-interactions can change the type without
  // silently breaking the host_browser path. Prefer an explicit error over an
  // optional-chain no-op that would leave the proxy request unresolved.
  if (!interaction.conversation) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      status: 400,
      message:
        "host_browser pending interaction has no associated conversation",
    };
  }

  interaction.conversation.resolveHostBrowser(requestId, {
    content: normalizedContent,
    isError: normalizedIsError,
  });

  return { ok: true };
}

/**
 * Result of attempting to resolve a `host_browser_event` frame. The
 * event surface never fails — every well-formed frame is published
 * to the runtime-side CDP event bus — so the resolution is either
 * `ok: true` or a `BAD_REQUEST` when the frame is malformed. Kept as
 * a discriminated union (rather than `void`) so the WS dispatcher
 * can log rejected frames with a consistent shape.
 */
export type HostBrowserEventResolution =
  | { ok: true }
  | {
      ok: false;
      code: "BAD_REQUEST";
      status: 400;
      message: string;
    };

/**
 * Shared resolver for `host_browser_event` envelopes. Publishes the
 * event into the module-level browser-session event bus where
 * runtime-side consumers can subscribe. Validation is intentionally
 * minimal — the frame is opaque to the bus and the bus's listeners
 * are the ones that care about params shape.
 */
export function resolveHostBrowserEvent(frame: {
  method?: unknown;
  params?: unknown;
  cdpSessionId?: unknown;
}): HostBrowserEventResolution {
  const { method, params, cdpSessionId } = frame;

  if (!method || typeof method !== "string") {
    return {
      ok: false,
      code: "BAD_REQUEST",
      status: 400,
      message: "method is required",
    };
  }

  publishCdpEvent({
    method,
    params,
    cdpSessionId:
      typeof cdpSessionId === "string" && cdpSessionId.length > 0
        ? cdpSessionId
        : undefined,
  });

  return { ok: true };
}

/**
 * Result of attempting to resolve a `host_browser_session_invalidated`
 * frame. Mirrors {@link HostBrowserEventResolution} — publishing into
 * the invalidated-target registry never fails, so the resolution is
 * either `ok: true` or a `BAD_REQUEST` on a malformed frame.
 */
export type HostBrowserSessionInvalidatedResolution =
  | { ok: true }
  | {
      ok: false;
      code: "BAD_REQUEST";
      status: 400;
      message: string;
    };

/**
 * Shared resolver for `host_browser_session_invalidated` envelopes.
 * Marks the target as invalidated in the runtime-side registry; the
 * next `BrowserSessionManager.send()` against that target will
 * evict the stale session and force the owning tool to reattach.
 *
 * A frame without a `targetId` is tolerated (some detach notifications
 * carry only a `reason`) but logged at info because it is less
 * actionable than a targeted invalidation — the caller can still
 * subscribe to the event bus to observe the signal.
 */
export function resolveHostBrowserSessionInvalidated(frame: {
  targetId?: unknown;
  reason?: unknown;
}): HostBrowserSessionInvalidatedResolution {
  const { targetId, reason } = frame;

  if (targetId !== undefined && typeof targetId !== "string") {
    return {
      ok: false,
      code: "BAD_REQUEST",
      status: 400,
      message: "targetId must be a string when present",
    };
  }

  if (typeof targetId === "string" && targetId.length > 0) {
    markTargetInvalidated(
      targetId,
      typeof reason === "string" ? reason : undefined,
    );
  }

  return { ok: true };
}

/**
 * POST /v1/host-browser-result — resolve a pending host browser request by requestId.
 * Requires AuthContext with guardian-bound actor.
 */
export async function handleHostBrowserResult(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const body = (await req.json()) as {
    requestId?: string;
    content?: string;
    isError?: boolean;
  };

  const resolution = resolveHostBrowserResultByRequestId(body);
  if (!resolution.ok) {
    return httpError(resolution.code, resolution.message, resolution.status);
  }

  return Response.json({ accepted: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function hostBrowserRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "host-browser-result",
      method: "POST",
      summary: "Submit host browser result",
      description: "Resolve a pending host browser request by requestId.",
      tags: ["host"],
      requestBody: z.object({
        requestId: z.string().describe("Pending browser request ID"),
        content: z.string().optional(),
        isError: z.boolean().optional(),
      }),
      responseBody: z.object({
        accepted: z.boolean(),
      }),
      handler: async ({ req, authContext }) =>
        handleHostBrowserResult(req, authContext),
    },
  ];
}
