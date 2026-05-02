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
import * as pendingInteractions from "../pending-interactions.js";
import { BadRequestError, NotFoundError } from "./errors.js";
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
      code: "BAD_REQUEST" | "NOT_FOUND";
      status: 400 | 404;
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

  if (!pendingInteractions.get(requestId)) {
    return {
      ok: false,
      code: "NOT_FOUND",
      status: 404,
      message: "No pending browser request for this requestId",
    };
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

function handleHostBrowserResult({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const resolution = resolveHostBrowserResultByRequestId(body);
  if (!resolution.ok) {
    if (resolution.code === "NOT_FOUND")
      throw new NotFoundError(resolution.message);
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
    handler: handleHostBrowserResult,
  },
];
