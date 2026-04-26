/**
 * Route handlers for host file transfer content streaming and result submission.
 *
 * - GET  /v1/transfers/:transferId/content — serve file bytes for to_host transfers
 * - PUT  /v1/transfers/:transferId/content — receive file bytes for to_sandbox transfers
 * - POST /v1/host-transfer-result          — resolve a pending to_host transfer
 */
import { z } from "zod";

import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

/**
 * Find the HostTransferProxy that owns a given transferId by scanning
 * all pending host_transfer interactions. Returns the proxy and the
 * interaction entry (with its requestId) so callers can resolve the
 * pending interaction when appropriate.
 */
function findProxyByTransferId(transferId: string) {
  const interactions = pendingInteractions.getByKind("host_transfer");
  for (const interaction of interactions) {
    const proxy = interaction.conversation?.getHostTransferProxy();
    if (proxy?.hasPendingTransfer(transferId)) {
      return { proxy, interaction };
    }
  }
  return null;
}

/**
 * GET /v1/transfers/:transferId/content — serve raw file bytes for a
 * to_host transfer. The client downloads these bytes and writes them
 * to the host filesystem.
 */
function handleTransferContentGet(
  transferId: string,
  authContext: AuthContext,
): Response {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const match = findProxyByTransferId(transferId);
  if (!match) {
    return httpError("NOT_FOUND", "Unknown or consumed transfer", 404);
  }

  const content = match.proxy.getTransferContent(transferId);
  if (!content) {
    return httpError("NOT_FOUND", "Unknown or consumed transfer", 404);
  }

  // Buffer extends Uint8Array at runtime but Bun's BodyInit typing doesn't
  // recognise it. Cast through unknown to satisfy the type checker.
  return new Response(content.buffer as unknown as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": content.sizeBytes.toString(),
      "X-Transfer-SHA256": content.sha256,
    },
  });
}

/**
 * PUT /v1/transfers/:transferId/content — receive raw file bytes for a
 * to_sandbox transfer. Verifies SHA-256 integrity and writes to the
 * sandbox destination path.
 */
async function handleTransferContentPut(
  transferId: string,
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const match = findProxyByTransferId(transferId);
  if (!match) {
    return httpError("NOT_FOUND", "Unknown or consumed transfer", 404);
  }

  const data = Buffer.from(await req.arrayBuffer());
  const sha256 = req.headers.get("X-Transfer-SHA256") ?? "";

  const result = await match.proxy.receiveTransferContent(
    transferId,
    data,
    sha256,
  );

  // For to_sandbox transfers there is no separate /v1/host-transfer-result
  // callback — the PUT handler is the terminal event. Always clean up the
  // pending interaction so it doesn't leak. (SHA-256 retry is a future
  // enhancement that requires matching client-side retry logic.)
  pendingInteractions.resolve(match.interaction.requestId);

  if (!result.accepted) {
    return httpError(
      "BAD_REQUEST",
      result.error ?? "Transfer content rejected",
      400,
    );
  }

  return Response.json({ accepted: true });
}

/**
 * POST /v1/host-transfer-result — resolve a pending to_host transfer
 * after the client has downloaded and written the file.
 */
async function handleTransferResult(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const body = (await req.json()) as {
    requestId?: string;
    isError?: boolean;
    bytesWritten?: number;
    errorMessage?: string;
  };

  const { requestId } = body;

  if (!requestId || typeof requestId !== "string") {
    return httpError("BAD_REQUEST", "requestId is required", 400);
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    return httpError(
      "NOT_FOUND",
      "No pending interaction found for this requestId",
      404,
    );
  }

  if (peeked.kind !== "host_transfer") {
    return httpError(
      "CONFLICT",
      `Pending interaction is of kind "${peeked.kind}", expected "host_transfer"`,
      409,
    );
  }

  // Validation passed — consume the pending interaction.
  const interaction = pendingInteractions.resolve(requestId)!;

  interaction.conversation!.resolveHostTransfer(requestId, {
    isError: body.isError ?? false,
    bytesWritten: body.bytesWritten,
    errorMessage: body.errorMessage,
  });

  return Response.json({ accepted: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function hostTransferRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "transfers/:transferId/content",
      method: "GET",
      policyKey: "transfers/content",
      summary: "Get transfer content",
      description:
        "Serve raw file bytes for a to_host transfer. Single-use: returns 404 after first consumption.",
      tags: ["host-transfer"],
      handler: ({ params, authContext }) =>
        handleTransferContentGet(params.transferId, authContext),
    },
    {
      endpoint: "transfers/:transferId/content",
      method: "PUT",
      policyKey: "transfers/content",
      summary: "Put transfer content",
      description:
        "Receive raw file bytes for a to_sandbox transfer. Verifies SHA-256 integrity via the X-Transfer-SHA256 header.",
      tags: ["host-transfer"],
      handler: ({ req, params, authContext }) =>
        handleTransferContentPut(params.transferId, req, authContext),
    },
    {
      endpoint: "host-transfer-result",
      method: "POST",
      summary: "Submit host transfer result",
      description:
        "Resolve a pending to_host transfer after the client has downloaded and written the file.",
      tags: ["host-transfer"],
      requestBody: z.object({
        requestId: z.string().describe("Pending transfer request ID"),
        isError: z.boolean().optional(),
        bytesWritten: z.number().optional(),
        errorMessage: z.string().optional(),
      }),
      responseBody: z.object({
        accepted: z.boolean(),
      }),
      handler: async ({ req, authContext }) =>
        handleTransferResult(req, authContext),
    },
  ];
}
