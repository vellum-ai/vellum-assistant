/**
 * Route handler for host file result submissions.
 *
 * Resolves pending host file proxy requests by requestId when the desktop
 * client returns execution results via HTTP.
 */
import { z } from "zod";

import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

/**
 * POST /v1/host-file-result — resolve a pending host file request by requestId.
 * Requires AuthContext with guardian-bound actor.
 */
export async function handleHostFileResult(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const body = (await req.json()) as {
    requestId?: string;
    content?: string;
    isError?: boolean;
    imageData?: string;
  };

  const { requestId, content, isError, imageData } = body;

  if (!requestId || typeof requestId !== "string") {
    return httpError("BAD_REQUEST", "requestId is required", 400);
  }

  // Peek first (non-destructive) so we can validate the interaction kind
  // without accidentally consuming a confirmation or secret interaction.
  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    return httpError(
      "NOT_FOUND",
      "No pending interaction found for this requestId",
      404,
    );
  }

  if (peeked.kind !== "host_file") {
    return httpError(
      "CONFLICT",
      `Pending interaction is of kind "${peeked.kind}", expected "host_file"`,
      409,
    );
  }

  // Validation passed — consume the pending interaction.
  const interaction = pendingInteractions.resolve(requestId)!;

  interaction.conversation!.resolveHostFile(requestId, {
    content: content ?? "",
    isError: isError ?? false,
    imageData,
  });

  return Response.json({ accepted: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function hostFileRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "host-file-result",
      method: "POST",
      summary: "Submit host file result",
      description:
        "Resolve a pending host file proxy request by requestId when the desktop client returns execution results.",
      tags: ["host-file"],
      handler: async ({ req, authContext }) =>
        handleHostFileResult(req, authContext),
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
    },
  ];
}
