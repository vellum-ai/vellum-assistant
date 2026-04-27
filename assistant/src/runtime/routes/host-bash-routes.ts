/**
 * Route handler for host bash result submissions.
 *
 * Resolves pending host bash proxy requests by requestId when the desktop
 * client returns execution results via HTTP.
 */
import { z } from "zod";

import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

/**
 * POST /v1/host-bash-result — resolve a pending host bash request by requestId.
 * Requires AuthContext with guardian-bound actor.
 */
async function handleHostBashResult(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const body = (await req.json()) as {
    requestId?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    timedOut?: boolean;
  };

  const { requestId, stdout, stderr, exitCode, timedOut } = body;

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

  if (peeked.kind !== "host_bash") {
    return httpError(
      "CONFLICT",
      `Pending interaction is of kind "${peeked.kind}", expected "host_bash"`,
      409,
    );
  }

  // Validation passed — consume the pending interaction.
  const interaction = pendingInteractions.resolve(requestId)!;

  interaction.conversation!.resolveHostBash(requestId, {
    stdout: stdout ?? "",
    stderr: stderr ?? "",
    exitCode: exitCode ?? null,
    timedOut: timedOut ?? false,
  });

  return Response.json({ accepted: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function hostBashRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "host-bash-result",
      method: "POST",
      summary: "Submit host bash result",
      description: "Resolve a pending host bash request by requestId.",
      tags: ["host"],
      requestBody: z.object({
        requestId: z.string().describe("Pending bash request ID"),
        stdout: z.string().optional(),
        stderr: z.string().optional(),
        exitCode: z.number().optional(),
        timedOut: z.boolean().optional(),
      }),
      responseBody: z.object({
        accepted: z.boolean(),
      }),
      handler: async ({ req, authContext }) =>
        handleHostBashResult(req, authContext),
    },
  ];
}
