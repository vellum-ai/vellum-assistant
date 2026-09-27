/**
 * Shared binding checks for host-proxy result (and transfer content) routes.
 *
 * Targeted requests still require the submitting client id to match the
 * pending `targetClientId`. When a request was dispatched untargeted, the
 * pending interaction may still carry `targetActorPrincipalId` (the turn's
 * source actor). In that case the same-actor check still runs so a different
 * principal cannot forge stdout/stderr/exitCode for someone else's command.
 *
 * Identity-less local flows (neither target client nor source actor recorded)
 * keep the open path.
 */
import { assistantEventHub } from "../assistant-event-hub.js";
import {
  enforceSameActorOrThrow,
  type SameActorOp,
} from "../auth/same-actor.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import { BadRequestError, ForbiddenError } from "./errors.js";

export function assertHostProxyConnectionBinding(args: {
  targetClientId?: string;
  targetConnectionId?: string;
}): void {
  if (!args.targetConnectionId) {
    return;
  }
  if (
    !assistantEventHub.hasActiveClientConnection(
      args.targetConnectionId,
      args.targetClientId,
    )
  ) {
    throw new ForbiddenError(
      "This host-proxy result is bound to a connection that is no longer active.",
    );
  }
}

export async function assertHostProxyResultBinding(args: {
  headers?: Record<string, string | undefined>;
  targetClientId?: string;
  targetConnectionId?: string;
  targetActorPrincipalId?: string;
  op: SameActorOp;
  missingClientIdMessage: string;
}): Promise<void> {
  const submittingClientId =
    args.headers?.["x-vellum-client-id"]?.trim() || undefined;
  const submittingActorPrincipalId =
    await resolveActorPrincipalIdForLocalGuardian(
      args.headers?.["x-vellum-actor-principal-id"]?.trim() || undefined,
    );

  if (args.targetClientId) {
    if (!submittingClientId) {
      throw new BadRequestError(args.missingClientIdMessage);
    }
    if (submittingClientId !== args.targetClientId) {
      throw new ForbiddenError(
        `Client "${submittingClientId}" is not the target for this request (expected "${args.targetClientId}"). The targeted client must submit the result.`,
      );
    }
  }

  assertHostProxyConnectionBinding({
    targetClientId: args.targetClientId,
    targetConnectionId: args.targetConnectionId,
  });

  if (!args.targetClientId && !args.targetActorPrincipalId) {
    return;
  }

  enforceSameActorOrThrow({
    sourceActorPrincipalId: submittingActorPrincipalId,
    targetActorPrincipalId: args.targetActorPrincipalId,
    targetClientId: args.targetClientId ?? submittingClientId ?? "",
    op: args.op,
    hubForMissingTarget: assistantEventHub,
  });
}
