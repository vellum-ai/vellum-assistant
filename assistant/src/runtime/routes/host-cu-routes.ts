/**
 * Route handler for host CU (computer-use) result submissions.
 *
 * Resolves pending host CU proxy requests by requestId when the desktop
 * client returns observation results via HTTP.
 */
import { z } from "zod";

import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

/**
 * POST /v1/host-cu-result — resolve a pending host CU request by requestId.
 * Requires AuthContext with guardian-bound actor.
 */
export async function handleHostCuResult(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const body = (await req.json()) as {
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

  const { requestId } = body;

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

  if (peeked.kind !== "host_cu") {
    return httpError(
      "CONFLICT",
      `Pending interaction is of kind "${peeked.kind}", expected "host_cu"`,
      409,
    );
  }

  // Validation passed — consume the pending interaction.
  const interaction = pendingInteractions.resolve(requestId)!;

  interaction.conversation!.resolveHostCu(requestId, {
    axTree: body.axTree,
    axDiff: body.axDiff,
    screenshot: body.screenshot,
    screenshotWidthPx: body.screenshotWidthPx,
    screenshotHeightPx: body.screenshotHeightPx,
    screenWidthPt: body.screenWidthPt,
    screenHeightPt: body.screenHeightPt,
    executionResult: body.executionResult,
    executionError: body.executionError,
    secondaryWindows: body.secondaryWindows,
    userGuidance: body.userGuidance,
  });

  return Response.json({ accepted: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function hostCuRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "host-cu-result",
      method: "POST",
      summary: "Submit host CU result",
      description: "Resolve a pending host computer-use request by requestId.",
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
      handler: async ({ req, authContext }) =>
        handleHostCuResult(req, authContext),
    },
  ];
}
