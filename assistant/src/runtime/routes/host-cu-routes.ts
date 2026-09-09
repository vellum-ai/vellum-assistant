/**
 * Route handler for host CU (computer-use) result submissions.
 *
 * Resolves pending host CU proxy requests by requestId when the desktop
 * client returns observation results via HTTP.
 */
import { z } from "zod";

import { findConversation } from "../../daemon/conversation-registry.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { SAME_ACTOR_FORBIDDEN_DESCRIPTION } from "../auth/same-actor.js";
import * as pendingInteractions from "../pending-interactions.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { assertHostProxyResultBinding } from "./host-proxy-result-binding.js";
import { parseBody } from "./parse-body.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Body of `POST /v1/host-cu-result`, declared as the route's `requestBody` and
 * parsed by the handler, so the OpenAPI contract and the runtime check are one
 * schema rather than two hand-kept copies.
 *
 * Unknown keys are stripped rather than rejected, so a desktop client that
 * reports a newer observation field still resolves its pending request.
 */
const HostCuResultBodySchema = z.object({
  requestId: z.string().min(1).describe("Pending CU request ID"),
  axTree: z.string().describe("Accessibility tree").optional(),
  axDiff: z.string().describe("Accessibility tree diff").optional(),
  screenshot: z.string().describe("Base64 screenshot").optional(),
  screenshotWidthPx: z.number().optional(),
  screenshotHeightPx: z.number().optional(),
  screenWidthPt: z.number().optional(),
  screenHeightPt: z.number().optional(),
  executionResult: z.string().optional(),
  executionError: z.string().optional(),
  secondaryWindows: z.string().optional(),
  userGuidance: z.string().optional(),
});

// ---------------------------------------------------------------------------
// POST /v1/host-cu-result
// ---------------------------------------------------------------------------

async function handleHostCuResult({ body, headers }: RouteHandlerArgs) {
  const {
    requestId,
    axTree,
    axDiff,
    screenshot,
    screenshotWidthPx,
    screenshotHeightPx,
    screenWidthPt,
    screenHeightPt,
    executionResult,
    executionError,
    secondaryWindows,
    userGuidance,
  } = parseBody(HostCuResultBodySchema, body);

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    throw new NotFoundError("No pending interaction found for this requestId");
  }

  if (peeked.kind !== "host_cu") {
    throw new ConflictError(
      `Pending interaction is of kind "${peeked.kind}", expected "host_cu"`,
    );
  }

  await assertHostProxyResultBinding({
    headers: headers as Record<string, string | undefined> | undefined,
    targetClientId: peeked.targetClientId,
    targetActorPrincipalId: peeked.targetActorPrincipalId,
    op: "host_cu",
    missingClientIdMessage:
      "x-vellum-client-id header is missing for a targeted host CU request.",
  });

  // Conversation-agnostic observation (see `runtime/host-observe.ts`): the
  // request was raised outside any turn, so there is no conversation and no CU
  // proxy to format the observation. Hand the raw fields to the waiting caller.
  if (peeked.conversationId === undefined) {
    const interaction = pendingInteractions.resolve(requestId, "answered");
    interaction?.rpcResolve?.({
      axTree,
      axDiff,
      screenshot,
      screenshotWidthPx,
      screenshotHeightPx,
      screenWidthPt,
      screenHeightPt,
      executionError,
    });
    return { accepted: true };
  }

  const conversation = findConversation(peeked.conversationId);
  if (!conversation) {
    pendingInteractions.resolve(requestId, "cancelled");
    throw new NotFoundError("Conversation not found for host CU result");
  }

  if (!conversation.hostCuProxy) {
    pendingInteractions.resolve(requestId, "cancelled");
    throw new NotFoundError("No host CU proxy for conversation");
  }

  conversation.hostCuProxy.processObservation(requestId, {
    axTree,
    axDiff,
    screenshot,
    screenshotWidthPx,
    screenshotHeightPx,
    screenWidthPt,
    screenHeightPt,
    executionResult,
    executionError,
    secondaryWindows,
    userGuidance,
  });

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "host_cu_result",
    endpoint: "host-cu-result",
    method: "POST",
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    requireGuardian: true,
    summary: "Submit host CU result",
    description: "Resolve a pending host computer-use request by requestId.",
    tags: ["host"],
    requestBody: HostCuResultBodySchema,
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted host CU request.",
      },
      "403": {
        description: SAME_ACTOR_FORBIDDEN_DESCRIPTION,
      },
      "404": {
        description:
          "No pending interaction found for the given requestId, or the conversation/proxy no longer exists.",
      },
      "409": {
        description:
          "Pending interaction exists but is of a different kind (e.g. host_bash, host_file).",
      },
    },
    handler: handleHostCuResult,
  },
];
