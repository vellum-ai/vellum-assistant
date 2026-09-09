/**
 * Route handler for host file result submissions.
 *
 * Resolves pending host file proxy requests by requestId when the desktop
 * client returns execution results via HTTP.
 */
import { z } from "zod";

import { HostFileProxy } from "../../daemon/host-file-proxy.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { SAME_ACTOR_FORBIDDEN_DESCRIPTION } from "../auth/same-actor.js";
import * as pendingInteractions from "../pending-interactions.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { assertHostProxyResultBinding } from "./host-proxy-result-binding.js";
import { parseBody } from "./parse-body.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Body of `POST /v1/host-file-result`, declared as the route's `requestBody`
 * and parsed by the handler, so the OpenAPI contract and the runtime check are
 * one schema rather than two hand-kept copies.
 *
 * Unknown keys are stripped rather than rejected, so a desktop client that
 * reports a newer result field still resolves its pending request.
 */
const HostFileResultBodySchema = z.object({
  requestId: z.string().min(1).describe("Pending request ID to resolve"),
  content: z.string().describe("File content result").optional(),
  isError: z.boolean().describe("Whether the result is an error").optional(),
  imageData: z
    .string()
    .describe("Optional base64-encoded image bytes for successful image reads")
    .optional(),
  audioData: z
    .string()
    .describe("Optional base64-encoded audio bytes for successful audio reads")
    .optional(),
  audioMimeType: z
    .string()
    .describe("MIME type for audioData (e.g. audio/mpeg)")
    .optional(),
});

// ---------------------------------------------------------------------------
// POST /v1/host-file-result
// ---------------------------------------------------------------------------

async function handleHostFileResult({ body, headers }: RouteHandlerArgs) {
  const { requestId, content, isError, imageData, audioData, audioMimeType } =
    parseBody(HostFileResultBodySchema, body);

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    throw new NotFoundError("No pending interaction found for this requestId");
  }

  if (peeked.kind !== "host_file") {
    throw new ConflictError(
      `Pending interaction is of kind "${peeked.kind}", expected "host_file"`,
    );
  }

  await assertHostProxyResultBinding({
    headers: headers as Record<string, string | undefined> | undefined,
    targetClientId: peeked.targetClientId,
    targetActorPrincipalId: peeked.targetActorPrincipalId,
    op: "host_file",
    missingClientIdMessage:
      "x-vellum-client-id header is missing for a targeted host file request.",
  });

  HostFileProxy.instance.resolve(requestId, {
    content: content ?? "",
    isError: isError ?? false,
    imageData,
    audioData,
    audioMimeType,
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
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    requireGuardian: true,
    summary: "Submit host file result",
    description:
      "Resolve a pending host file proxy request by requestId when the desktop client returns execution results.",
    tags: ["host-file"],
    requestBody: HostFileResultBodySchema,
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted host file request.",
      },
      "403": {
        description: SAME_ACTOR_FORBIDDEN_DESCRIPTION,
      },
      "404": {
        description: "No pending interaction found for the given requestId.",
      },
      "409": {
        description:
          "Pending interaction exists but is of a different kind (e.g. host_bash, host_cu).",
      },
    },
    handler: handleHostFileResult,
  },
];
