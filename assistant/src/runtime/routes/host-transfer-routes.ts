/**
 * Route handlers for host file transfer content streaming and result submission.
 *
 * - GET  /v1/transfers/:transferId/content — serve file bytes for to_host transfers
 * - PUT  /v1/transfers/:transferId/content — receive file bytes for to_sandbox transfers
 * - POST /v1/host-transfer-result          — resolve a pending to_host transfer
 */
import { z } from "zod";

import { HostTransferProxy } from "../../daemon/host-transfer-proxy.js";
import * as pendingInteractions from "../pending-interactions.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Find the singleton HostTransferProxy if it owns the given transferId.
 * Returns the proxy and the matching requestId so callers can resolve
 * the pending interaction when appropriate.
 */
function findProxyByTransferId(transferId: string) {
  const proxy = HostTransferProxy.instance;
  const requestId = proxy.getRequestIdForTransfer(transferId);
  if (!requestId) return null;
  return { proxy, requestId };
}

// ---------------------------------------------------------------------------
// GET /v1/transfers/:transferId/content
// ---------------------------------------------------------------------------

function handleTransferContentGet({
  pathParams = {},
  headers = {},
}: RouteHandlerArgs): Uint8Array {
  const transferId = pathParams.transferId;
  if (!transferId) {
    throw new BadRequestError("transferId path parameter is required");
  }

  const match = findProxyByTransferId(transferId);
  if (!match) {
    throw new NotFoundError("Unknown or consumed transfer");
  }

  const targetClientId = match.proxy.getTargetClientIdForTransfer(transferId);
  if (targetClientId != null) {
    const submittingClientId = (headers as Record<string, string>)["x-vellum-client-id"]?.trim() || undefined;
    if (!submittingClientId) throw new BadRequestError("x-vellum-client-id header required for targeted transfer");
    if (submittingClientId !== targetClientId) throw new ForbiddenError(`Client "${submittingClientId}" is not the owner of this transfer`);
  }

  const content = match.proxy.getTransferContent(transferId);
  if (!content) {
    throw new NotFoundError("Unknown or consumed transfer");
  }

  return new Uint8Array(content.buffer);
}

/**
 * Resolve Content-Length and X-Transfer-SHA256 response headers for the
 * GET transfer content endpoint. Called by the HTTP adapter AFTER the handler
 * runs (`http-adapter.ts:107-125`), so the entry has already been consumed by
 * `getTransferContent`. We read the size/sha256 from
 * `takeJustConsumedTransferMetadata`, which the proxy populates synchronously
 * during the handler's `getTransferContent` call.
 */
function resolveTransferContentGetHeaders({
  pathParams = {},
}: {
  pathParams?: Record<string, string>;
}): Record<string, string> {
  const transferId = pathParams?.transferId;
  if (!transferId) return { "Content-Type": "application/octet-stream" };

  const meta =
    HostTransferProxy.instance.takeJustConsumedTransferMetadata(transferId);
  if (!meta) return { "Content-Type": "application/octet-stream" };

  return {
    "Content-Type": "application/octet-stream",
    "Content-Length": meta.sizeBytes.toString(),
    "X-Transfer-SHA256": meta.sha256,
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/transfers/:transferId/content
// ---------------------------------------------------------------------------

async function handleTransferContentPut({
  pathParams = {},
  rawBody,
  headers = {},
}: RouteHandlerArgs) {
  const transferId = pathParams.transferId;
  if (!transferId) {
    throw new BadRequestError("transferId path parameter is required");
  }

  const match = findProxyByTransferId(transferId);
  if (!match) {
    throw new NotFoundError("Unknown or consumed transfer");
  }

  const targetClientId = match.proxy.getTargetClientIdForTransfer(transferId);
  if (targetClientId != null) {
    const submittingClientId = (headers as Record<string, string>)["x-vellum-client-id"]?.trim() || undefined;
    if (!submittingClientId) throw new BadRequestError("x-vellum-client-id header required for targeted transfer");
    if (submittingClientId !== targetClientId) throw new ForbiddenError(`Client "${submittingClientId}" is not the owner of this transfer`);
  }

  const data = rawBody ? Buffer.from(rawBody) : Buffer.alloc(0);
  const sha256 = headers["x-transfer-sha256"] ?? "";

  const result = await match.proxy.receiveTransferContent(
    transferId,
    data,
    sha256,
  );

  if (!result.accepted) {
    throw new BadRequestError(result.error ?? "Transfer content rejected");
  }

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// POST /v1/host-transfer-result
// ---------------------------------------------------------------------------

function handleTransferResult({ body, headers }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { requestId, isError, bytesWritten, errorMessage } = body as {
    requestId?: string;
    isError?: boolean;
    bytesWritten?: number;
    errorMessage?: string;
  };

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    throw new NotFoundError("No pending interaction found for this requestId");
  }

  if (peeked.kind !== "host_transfer") {
    throw new ConflictError(
      `Pending interaction is of kind "${peeked.kind}", expected "host_transfer"`,
    );
  }

  if (peeked.targetClientId != null) {
    const rawClientId = (headers as Record<string, string | undefined>)?.["x-vellum-client-id"];
    const submittingClientId = rawClientId?.trim() || undefined;
    if (!submittingClientId) throw new BadRequestError("x-vellum-client-id header is missing for a targeted host transfer request.");
    if (submittingClientId !== peeked.targetClientId) throw new ForbiddenError(`Client "${submittingClientId}" is not the target for this request (expected "${peeked.targetClientId}").`);
  }

  HostTransferProxy.instance.resolveTransferResult(requestId, {
    isError: isError ?? false,
    bytesWritten,
    errorMessage,
  });

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "transfers_get_content",
    endpoint: "transfers/:transferId/content",
    method: "GET",
    policyKey: "transfers/content",
    requireGuardian: true,
    summary: "Get transfer content",
    description:
      "Serve raw file bytes for a to_host transfer. Single-use: returns 404 after first consumption.",
    tags: ["host-transfer"],
    responseHeaders: resolveTransferContentGetHeaders,
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted transfer.",
      },
      "403": {
        description:
          "Submitting client does not match the targeted client for this transfer.",
      },
    },
    handler: handleTransferContentGet,
  },
  {
    operationId: "transfers_put_content",
    endpoint: "transfers/:transferId/content",
    method: "PUT",
    policyKey: "transfers/content",
    requireGuardian: true,
    summary: "Put transfer content",
    description:
      "Receive raw file bytes for a to_sandbox transfer. Verifies SHA-256 integrity via the X-Transfer-SHA256 header.",
    tags: ["host-transfer"],
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted transfer.",
      },
      "403": {
        description:
          "Submitting client does not match the targeted client for this transfer.",
      },
    },
    handler: handleTransferContentPut,
  },
  {
    operationId: "host_transfer_result",
    endpoint: "host-transfer-result",
    method: "POST",
    requireGuardian: true,
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
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted host transfer request.",
      },
      "403": {
        description:
          "Submitting client does not match the targeted client for this transfer.",
      },
    },
    handler: handleTransferResult,
  },
];
