/**
 * Route handler for host bash result submissions.
 *
 * Resolves pending host bash proxy requests by requestId when the desktop
 * client returns execution results via HTTP.
 */
import { z } from "zod";

import { HostBashProxy } from "../../daemon/host-bash-proxy.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  enforceSameActorOrThrow,
  SAME_ACTOR_FORBIDDEN_DESCRIPTION,
} from "../auth/same-actor.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import * as pendingInteractions from "../pending-interactions.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.js";
import { parseBody } from "./parse-body.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Body of `POST /v1/host-bash-result`, declared as the route's `requestBody`
 * and parsed by the handler, so the OpenAPI contract and the runtime check are
 * one schema rather than two hand-kept copies.
 *
 * `exitCode` is nullable because a process terminated by a signal has no exit
 * status: the desktop executor forwards Node's `close` argument verbatim, which
 * is `null` on signal termination (including its own timeout kill). The proxy
 * result type carries that `null` through to the tool output.
 *
 * Unknown keys are stripped rather than rejected, so a desktop client that
 * reports a newer result field still resolves its pending request.
 */
const HostBashResultBodySchema = z.object({
  requestId: z.string().min(1).describe("Pending bash request ID"),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z
    .number()
    .nullable()
    .describe("Process exit status, or null when terminated by a signal")
    .optional(),
  timedOut: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// POST /v1/host-bash-result
// ---------------------------------------------------------------------------

async function handleHostBashResult({ body, headers }: RouteHandlerArgs) {
  const { requestId, stdout, stderr, exitCode, timedOut } = parseBody(
    HostBashResultBodySchema,
    body,
  );

  const submittingClientId =
    headers?.["x-vellum-client-id"]?.trim() || undefined;
  const submittingActorPrincipalId =
    await resolveActorPrincipalIdForLocalGuardian(
      headers?.["x-vellum-actor-principal-id"]?.trim() || undefined,
    );

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    throw new NotFoundError("No pending interaction found for this requestId");
  }

  if (peeked.kind !== "host_bash") {
    throw new ConflictError(
      `Pending interaction is of kind "${peeked.kind}", expected "host_bash"`,
    );
  }

  const { targetClientId } = peeked;
  if (targetClientId) {
    if (!submittingClientId) {
      throw new BadRequestError(
        "x-vellum-client-id header is required for targeted host bash requests",
      );
    }
    if (submittingClientId !== targetClientId) {
      throw new ForbiddenError(
        `Client "${submittingClientId}" is not the target for this request (expected "${targetClientId}"). The targeted client must submit the result.`,
      );
    }

    // Defense-in-depth on top of the client-id header binding above: the
    // submitting actor's principal must match the actor principal stored
    // for the target client at SSE subscription time. This prevents a
    // cross-user submission even when the attacker can guess or spoof the
    // target's client ID.
    enforceSameActorOrThrow({
      sourceActorPrincipalId: submittingActorPrincipalId,
      targetActorPrincipalId: peeked.targetActorPrincipalId,
      targetClientId,
      op: "host_bash",
      hubForMissingTarget: assistantEventHub,
    });
  }

  HostBashProxy.instance.resolveResult(requestId, {
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
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    requireGuardian: true,
    summary: "Submit host bash result",
    description: "Resolve a pending host bash request by requestId.",
    tags: ["host"],
    requestBody: HostBashResultBodySchema,
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted host bash request.",
      },
      "403": {
        description: SAME_ACTOR_FORBIDDEN_DESCRIPTION,
      },
      "404": {
        description: "No pending interaction found for the given requestId.",
      },
      "409": {
        description:
          "Pending interaction exists but is of a different kind (e.g. host_file, host_cu).",
      },
    },
    handler: handleHostBashResult,
  },
];
