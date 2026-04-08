/**
 * Route handler for host browser result submissions.
 *
 * Resolves pending host browser proxy requests by requestId when the desktop
 * client returns CDP results via HTTP.
 */
import { z } from "zod";

import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

/**
 * POST /v1/host-browser-result — resolve a pending host browser request by requestId.
 * Requires AuthContext with guardian-bound actor.
 */
export async function handleHostBrowserResult(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const body = (await req.json()) as {
    requestId?: string;
    content?: string;
    isError?: boolean;
  };

  const { requestId, content, isError } = body;

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

  if (peeked.kind !== "host_browser") {
    return httpError(
      "CONFLICT",
      `Pending interaction is of kind "${peeked.kind}", expected "host_browser"`,
      409,
    );
  }

  // Validation passed — consume the pending interaction.
  const interaction = pendingInteractions.resolve(requestId)!;

  // The host_browser kind always has a conversation attached at register time
  // (HostBrowserProxy.request wires it through), so this guard exists so a
  // future refactor of pending-interactions can change the type without
  // silently breaking the host_browser path. Prefer an explicit 400 over an
  // optional-chain no-op that would leave the proxy request unresolved.
  if (!interaction.conversation) {
    return httpError(
      "BAD_REQUEST",
      "host_browser pending interaction has no associated conversation",
      400,
    );
  }

  interaction.conversation.resolveHostBrowser(requestId, {
    content: content ?? "",
    isError: isError ?? false,
  });

  return Response.json({ accepted: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function hostBrowserRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "host-browser-result",
      method: "POST",
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
      handler: async ({ req, authContext }) =>
        handleHostBrowserResult(req, authContext),
    },
  ];
}
