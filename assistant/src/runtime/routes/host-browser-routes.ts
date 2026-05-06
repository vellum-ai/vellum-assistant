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
import { HostBrowserProxy } from "../../daemon/host-browser-proxy.js";
import {
  enforceSameActorOrThrow,
  SAME_ACTOR_FORBIDDEN_DESCRIPTION,
} from "../auth/same-actor.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import * as pendingInteractions from "../pending-interactions.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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
      code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";
      status: 400 | 403 | 404 | 409;
      message: string;
    };

/**
 * Resolver for the `POST /v1/host-browser-result` HTTP route. Looks up
 * the pending interaction by requestId, validates its kind is
 * `host_browser`, and forwards the response to the owning conversation.
 *
 * Same-actor binding: when the pending interaction has a
 * `targetClientId` (set by the proxy at request time when an actor is
 * known), the submitting client must (a) identify itself via
 * `x-vellum-client-id` matching the captured target, and (b) the
 * submitting actor's principal must match the actor captured for that
 * client at registration time. Mirrors the host-cu / host-bash result
 * routes.
 *
 * NOTE: The WebSocket `host_browser_result` frame path does NOT go
 * through this function — it is handled by `HostBrowserProxy.resolveResult`
 * directly, which only consults `pendingInteractions` and does not
 * currently perform a kind check. That asymmetry is pre-existing; if
 * the WS path is ever opened to less-trusted clients, it should adopt
 * the same kind-check + actor-binding guards added here.
 *
 * This function does NOT perform auth — callers are expected to have
 * already authenticated the caller (the HTTP route uses
 * `requireBoundGuardian`).
 */
export function resolveHostBrowserResultByRequestId(
  frame: {
    requestId?: unknown;
    content?: unknown;
    isError?: unknown;
  },
  headers?: Record<string, string | undefined>,
): HostBrowserResultResolution {
  const { requestId, content, isError } = frame;

  if (!requestId || typeof requestId !== "string") {
    return {
      ok: false,
      code: "BAD_REQUEST",
      status: 400,
      message: "requestId is required",
    };
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    return {
      ok: false,
      code: "NOT_FOUND",
      status: 404,
      message: "No pending browser request for this requestId",
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

  // Validate submitting client matches the targeted client (if any).
  if (peeked.targetClientId != null) {
    const headerMap = headers ?? {};
    const submittingClientId =
      headerMap["x-vellum-client-id"]?.trim() || undefined;
    if (!submittingClientId) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        status: 400,
        message:
          "x-vellum-client-id header is missing for a targeted host browser request.",
      };
    }
    if (submittingClientId !== peeked.targetClientId) {
      return {
        ok: false,
        code: "FORBIDDEN",
        status: 403,
        message: `Client "${submittingClientId}" is not the target for this request (expected "${peeked.targetClientId}"). The targeted client must submit the result.`,
      };
    }

    // Defense-in-depth: require the submitting actor's principal id to match
    // the actor principal id captured when the target client opened its SSE
    // stream. This prevents a different authenticated user with knowledge of
    // both the requestId and target clientId from submitting a result on
    // behalf of the targeted client.
    const submittingActorPrincipalId = resolveActorPrincipalIdForLocalGuardian(
      headerMap["x-vellum-actor-principal-id"]?.trim() || undefined,
    );
    try {
      enforceSameActorOrThrow({
        sourceActorPrincipalId: submittingActorPrincipalId,
        targetActorPrincipalId: peeked.targetActorPrincipalId,
        targetClientId: peeked.targetClientId,
        op: "host_browser",
      });
    } catch (err) {
      // enforceSameActorOrThrow throws ForbiddenError on rejection.
      return {
        ok: false,
        code: "FORBIDDEN",
        status: 403,
        message: err instanceof Error ? err.message : "Same-actor check failed",
      };
    }
  }

  const normalizedContent = typeof content === "string" ? content : "";
  const normalizedIsError = typeof isError === "boolean" ? isError : false;

  const proxy = HostBrowserProxy.instance;
  proxy.resolveResult(requestId, {
    content: normalizedContent,
    isError: normalizedIsError,
  });

  return { ok: true };
}

/**
 * Result of attempting to resolve a `host_browser_event` frame.
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
 * runtime-side consumers can subscribe.
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
 * Result of attempting to resolve a `host_browser_session_invalidated` frame.
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
 * Marks the target as invalidated in the runtime-side registry.
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

// ---------------------------------------------------------------------------
// POST /v1/host-browser-result
// ---------------------------------------------------------------------------

function handleHostBrowserResult({ body, headers }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const resolution = resolveHostBrowserResultByRequestId(
    body,
    headers as Record<string, string | undefined> | undefined,
  );
  if (!resolution.ok) {
    if (resolution.code === "FORBIDDEN")
      throw new ForbiddenError(resolution.message);
    if (resolution.code === "NOT_FOUND")
      throw new NotFoundError(resolution.message);
    if (resolution.code === "CONFLICT")
      throw new ConflictError(resolution.message);
    throw new BadRequestError(resolution.message);
  }

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// POST /v1/host-browser-event
// ---------------------------------------------------------------------------

function handleHostBrowserEvent({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const resolution = resolveHostBrowserEvent(body);
  if (!resolution.ok) {
    throw new BadRequestError(resolution.message);
  }

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// POST /v1/host-browser-session-invalidated
// ---------------------------------------------------------------------------

function handleHostBrowserSessionInvalidated({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const resolution = resolveHostBrowserSessionInvalidated(body);
  if (!resolution.ok) {
    throw new BadRequestError(resolution.message);
  }

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "host_browser_result",
    endpoint: "host-browser-result",
    method: "POST",
    requireGuardian: true,
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
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted host browser request.",
      },
      "403": {
        description: SAME_ACTOR_FORBIDDEN_DESCRIPTION,
      },
      "404": {
        description: "No pending browser request for the given requestId.",
      },
      "409": {
        description:
          "Pending interaction kind is not host_browser (mismatched proxy ID space).",
      },
    },
    handler: handleHostBrowserResult,
  },
  {
    operationId: "host_browser_event",
    endpoint: "host-browser-event",
    method: "POST",
    requireGuardian: true,
    summary: "Forward a CDP event from the browser extension",
    description:
      "Publishes a chrome.debugger.onEvent firing into the runtime-side browser-session event bus.",
    tags: ["host"],
    requestBody: z.object({
      method: z.string().describe("CDP event method name"),
      params: z.unknown().optional().describe("CDP event parameters"),
      cdpSessionId: z
        .string()
        .optional()
        .describe("CDP session ID (if target-scoped)"),
    }),
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    handler: handleHostBrowserEvent,
  },
  {
    operationId: "host_browser_session_invalidated",
    endpoint: "host-browser-session-invalidated",
    method: "POST",
    requireGuardian: true,
    summary: "Notify runtime that a CDP session was invalidated",
    description:
      "Marks the target as invalidated in the runtime-side browser session registry.",
    tags: ["host"],
    requestBody: z.object({
      targetId: z
        .string()
        .optional()
        .describe("CDP target that was detached"),
      reason: z.string().optional().describe("Detach reason"),
    }),
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    handler: handleHostBrowserSessionInvalidated,
  },
];
