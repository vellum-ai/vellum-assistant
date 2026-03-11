/**
 * Route handler for host bash result submissions.
 *
 * Resolves pending host bash proxy requests by requestId when the desktop
 * client returns execution results via HTTP.
 */
import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

/**
 * POST /v1/host-bash-result — resolve a pending host bash request by requestId.
 * Requires AuthContext with guardian-bound actor.
 */
export async function handleHostBashResult(
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

  const interaction = pendingInteractions.resolve(requestId);
  if (!interaction) {
    return httpError(
      "NOT_FOUND",
      "No pending interaction found for this requestId",
      404,
    );
  }

  interaction.session.resolveHostBash(requestId, {
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
      handler: async ({ req, authContext }) =>
        handleHostBashResult(req, authContext),
    },
  ];
}
