/**
 * Route handler for host CU (computer-use) result submissions.
 *
 * Resolves pending host CU proxy requests by requestId when the desktop
 * client returns observation results via HTTP.
 */
import { z } from "zod";

import { findConversation } from "../../daemon/conversation-store.js";
import * as pendingInteractions from "../pending-interactions.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// POST /v1/host-cu-result
// ---------------------------------------------------------------------------

function handleHostCuResult({ body, headers }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

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
  } = body as {
    requestId?: string;
    axTree?: string;
    axDiff?: string;
    screenshot?: string;
    screenshotWidthPx?: number;
    screenshotHeightPx?: number;
    screenWidthPt?: number;
    screenHeightPt?: number;
    executionResult?: string;
    executionError?: string;
    secondaryWindows?: string;
    userGuidance?: string;
  };

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    throw new NotFoundError(
      "No pending interaction found for this requestId",
    );
  }

  if (peeked.kind !== "host_cu") {
    throw new ConflictError(
      `Pending interaction is of kind "${peeked.kind}", expected "host_cu"`,
    );
  }

  const submittingClientId = headers?.["x-vellum-client-id"]?.trim() || undefined;
  const { targetClientId } = peeked;
  if (targetClientId) {
    if (!submittingClientId) {
      throw new BadRequestError(
        "x-vellum-client-id header is required for targeted host CU requests",
      );
    }
    if (submittingClientId !== targetClientId) {
      throw new ForbiddenError(
        `Client "${submittingClientId}" is not the target for this request (expected "${targetClientId}"). The targeted client must submit the result.`,
      );
    }
  }

  const interaction = pendingInteractions.resolve(requestId)!;
  const conversation = findConversation(interaction.conversationId);
  if (!conversation) {
    throw new NotFoundError("Conversation not found for host CU result");
  }

  conversation.hostCuProxy?.resolve(requestId, {
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
    requireGuardian: true,
    summary: "Submit host CU result",
    description:
      "Resolve a pending host computer-use request by requestId.",
    tags: ["host"],
    requestBody: z.object({
      requestId: z.string().describe("Pending CU request ID"),
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
    }),
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted host CU request.",
      },
      "403": {
        description:
          "Submitting client does not match the targeted client for this request.",
      },
    },
    handler: handleHostCuResult,
  },
];
