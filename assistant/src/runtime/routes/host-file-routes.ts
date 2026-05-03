/**
 * Route handler for host file result submissions.
 *
 * Resolves pending host file proxy requests by requestId when the desktop
 * client returns execution results via HTTP.
 */
import { z } from "zod";

import { HostFileProxy } from "../../daemon/host-file-proxy.js";
import * as pendingInteractions from "../pending-interactions.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// POST /v1/host-file-result
// ---------------------------------------------------------------------------

function handleHostFileResult({ body, headers }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { requestId, content, isError, imageData } = body as {
    requestId?: string;
    content?: string;
    isError?: boolean;
    imageData?: string;
  };

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    throw new NotFoundError("No pending interaction found for this requestId");
  }

  if (peeked.kind !== "host_file") {
    throw new ConflictError(
      `Pending interaction is of kind "${peeked.kind}", expected "host_file"`,
    );
  }

  // Validate submitting client matches the targeted client (if any).
  if (peeked.targetClientId != null) {
    const rawClientId = (headers as Record<string, string | undefined>)?.["x-vellum-client-id"];
    const submittingClientId = rawClientId?.trim() || undefined;
    if (!submittingClientId) {
      throw new BadRequestError("x-vellum-client-id header is missing for a targeted host file request.");
    }
    if (submittingClientId !== peeked.targetClientId) {
      throw new ForbiddenError(
        `Client "${submittingClientId}" is not the target for this request (expected "${peeked.targetClientId}"). The targeted client must submit the result.`,
      );
    }
  }

  HostFileProxy.instance.resolve(requestId, {
    content: content ?? "",
    isError: isError ?? false,
    imageData,
  });

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "host_file_result",
    endpoint: "host-file-result",
    method: "POST",
    requireGuardian: true,
    summary: "Submit host file result",
    description:
      "Resolve a pending host file proxy request by requestId when the desktop client returns execution results.",
    tags: ["host-file"],
    requestBody: z.object({
      requestId: z.string().describe("Pending request ID to resolve"),
      content: z.string().describe("File content result").optional(),
      isError: z
        .boolean()
        .describe("Whether the result is an error")
        .optional(),
      imageData: z
        .string()
        .describe(
          "Optional base64-encoded image bytes for successful image reads",
        )
        .optional(),
    }),
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted host file request.",
      },
      "403": {
        description:
          "Submitting client does not match the targeted client for this request.",
      },
    },
    handler: handleHostFileResult,
  },
];
