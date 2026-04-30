/**
 * Route handler for host bash result submissions.
 *
 * Resolves pending host bash proxy requests by requestId when the desktop
 * client returns execution results via HTTP.
 */
import { z } from "zod";

import { HostBashProxy } from "../../daemon/host-bash-proxy.js";
import * as pendingInteractions from "../pending-interactions.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// POST /v1/host-bash-result
// ---------------------------------------------------------------------------

function handleHostBashResult({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { requestId, stdout, stderr, exitCode, timedOut } = body as {
    requestId?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    timedOut?: boolean;
  };

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    throw new NotFoundError(
      "No pending interaction found for this requestId",
    );
  }

  if (peeked.kind !== "host_bash") {
    throw new ConflictError(
      `Pending interaction is of kind "${peeked.kind}", expected "host_bash"`,
    );
  }

  pendingInteractions.resolve(requestId);

  HostBashProxy.instance.resolve(requestId, {
    stdout: stdout ?? "",
    stderr: stderr ?? "",
    exitCode: exitCode ?? null,
    timedOut: timedOut ?? false,
  });

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "host_bash_result",
    endpoint: "host-bash-result",
    method: "POST",
    requireGuardian: true,
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
    handler: handleHostBashResult,
  },
];
