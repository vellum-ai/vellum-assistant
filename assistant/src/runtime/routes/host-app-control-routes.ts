/**
 * Route handler for host app-control result submissions.
 *
 * Resolves pending host app-control proxy requests by requestId when the
 * desktop client returns observation/action results via HTTP. App-control
 * sessions are per-conversation (not a singleton like host-browser), so we
 * look up the owning conversation through the pending-interactions tracker
 * and forward the payload to that conversation's `hostAppControlProxy`.
 *
 * Late-delivery tolerance: returns 200 even when no pending interaction
 * matches (e.g. the conversation was disposed before the client reported
 * back). The proxy is best-effort — there is no consumer to notify, so a
 * 4xx would only confuse a client that already executed the action.
 */
import { z } from "zod";

import { findConversation } from "../../daemon/conversation-store.js";
import type {
  HostAppControlResultPayload,
  HostAppControlState,
} from "../../daemon/message-types/host-app-control.js";
import * as pendingInteractions from "../pending-interactions.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const VALID_STATES: ReadonlySet<HostAppControlState> = new Set([
  "running",
  "missing",
  "minimized",
]);

// ---------------------------------------------------------------------------
// POST /v1/host-app-control-result
// ---------------------------------------------------------------------------

function handleHostAppControlResult({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const {
    requestId,
    state,
    pngBase64,
    windowBounds,
    executionResult,
    executionError,
  } = body as {
    requestId?: string;
    state?: string;
    pngBase64?: string;
    windowBounds?: { x: number; y: number; width: number; height: number };
    executionResult?: string;
    executionError?: string;
  };

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  if (!state || !VALID_STATES.has(state as HostAppControlState)) {
    throw new BadRequestError(
      "state must be one of: running, missing, minimized",
    );
  }

  // Late-delivery tolerance: if the pending interaction is already gone (the
  // proxy timed out, the conversation was disposed, etc.), accept the post
  // and move on. There is no consumer left to fail loudly to.
  const peeked = pendingInteractions.get(requestId);
  if (!peeked || peeked.kind !== "host_app_control") {
    return { accepted: true };
  }

  const interaction = pendingInteractions.resolve(requestId)!;
  const conversation = findConversation(interaction.conversationId);
  if (!conversation) {
    return { accepted: true };
  }

  const payload: HostAppControlResultPayload = {
    requestId,
    state: state as HostAppControlState,
    ...(pngBase64 !== undefined ? { pngBase64 } : {}),
    ...(windowBounds !== undefined ? { windowBounds } : {}),
    ...(executionResult !== undefined ? { executionResult } : {}),
    ...(executionError !== undefined ? { executionError } : {}),
  };

  conversation.hostAppControlProxy?.resolve(requestId, payload);

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "host_app_control_result",
    endpoint: "host-app-control-result",
    method: "POST",
    requireGuardian: true,
    summary: "Submit host app-control result",
    description:
      "Resolve a pending host app-control request by requestId. Returns 200 even when no pending interaction matches (late delivery is tolerated).",
    tags: ["host"],
    requestBody: z.object({
      requestId: z.string().describe("Pending app-control request ID"),
      state: z
        .enum(["running", "missing", "minimized"])
        .describe("Lifecycle state of the targeted application"),
      pngBase64: z
        .string()
        .describe("Base64 PNG screenshot of the targeted app window")
        .optional(),
      windowBounds: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        })
        .optional(),
      executionResult: z.string().optional(),
      executionError: z.string().optional(),
    }),
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    handler: handleHostAppControlResult,
  },
];
