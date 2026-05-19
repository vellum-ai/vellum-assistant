/**
 * Route handler for host camera result submissions.
 *
 * Resolves pending one-shot camera snapshot requests. The raw image bytes are
 * forwarded only to the awaiting proxy, which summarizes and discards them.
 */
import { z } from "zod";

import { findConversation } from "../../daemon/conversation-store.js";
import type { HostCameraResultPayload } from "../../daemon/message-types/host-camera.js";
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

function handleHostCameraResult({ body, headers }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { requestId, imageBase64, mediaType, width, height, error } =
    body as unknown as HostCameraResultPayload;

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    throw new NotFoundError("No pending interaction found for this requestId");
  }
  if (peeked.kind !== "host_camera") {
    throw new ConflictError(
      `Pending interaction is of kind "${peeked.kind}", expected "host_camera"`,
    );
  }

  if (peeked.targetClientId != null) {
    const headerMap = (headers as Record<string, string | undefined>) ?? {};
    const submittingClientId =
      headerMap["x-vellum-client-id"]?.trim() || undefined;
    if (!submittingClientId) {
      throw new BadRequestError(
        "x-vellum-client-id header is missing for a targeted host camera request.",
      );
    }
    if (submittingClientId !== peeked.targetClientId) {
      throw new ForbiddenError(
        `Client "${submittingClientId}" is not the target for this request (expected "${peeked.targetClientId}"). The targeted client must submit the result.`,
      );
    }
    const submittingActorPrincipalId = resolveActorPrincipalIdForLocalGuardian(
      headerMap["x-vellum-actor-principal-id"]?.trim() || undefined,
    );
    enforceSameActorOrThrow({
      sourceActorPrincipalId: submittingActorPrincipalId,
      targetActorPrincipalId: peeked.targetActorPrincipalId,
      targetClientId: peeked.targetClientId,
      op: "host_camera",
    });
  }

  const interaction = pendingInteractions.resolve(requestId)!;
  const conversation = findConversation(interaction.conversationId);
  if (!conversation) {
    return { accepted: true };
  }

  conversation.hostCameraProxy?.resolve(requestId, {
    requestId,
    ...(typeof imageBase64 === "string" ? { imageBase64 } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
    ...(typeof error === "string" ? { error } : {}),
  });

  return { accepted: true };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "host_camera_result",
    endpoint: "host-camera-result",
    method: "POST",
    requireGuardian: true,
    summary: "Submit host camera snapshot result",
    description:
      "Resolve a pending one-shot host camera snapshot request by requestId.",
    tags: ["host"],
    requestBody: z.object({
      requestId: z.string().describe("Pending camera request ID"),
      imageBase64: z
        .string()
        .describe("Base64-encoded one-shot webcam image")
        .optional(),
      mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      error: z.string().optional(),
    }),
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted host camera request.",
      },
      "403": {
        description: SAME_ACTOR_FORBIDDEN_DESCRIPTION,
      },
      "404": {
        description: "No pending interaction found for the given requestId.",
      },
      "409": {
        description: "Pending interaction exists but is of a different kind.",
      },
    },
    handler: handleHostCameraResult,
  },
];
