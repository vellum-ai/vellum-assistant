/**
 * Requester trust resolution for vellum-channel surface routes.
 *
 * Maps the verified `x-vellum-actor-principal-id` header to a
 * {@link TrustContext} via the gateway guardian binding: a vellum principal
 * is the guardian or nobody, so the mapper yields guardian or unknown. No
 * header means a local/IPC caller, which is the guardian by construction.
 *
 * Shared by `surface-action-routes` (which additionally stamps the result
 * onto the conversation) and `surface-content-routes` (which only reads it
 * to scope the persisted-surface fallback) so the two routes cannot drift.
 */
import { isHttpAuthDisabled } from "../../config/env.js";
import type { TrustContext } from "../../daemon/trust-context-types.js";
import { getLogger } from "../../util/logger.js";
import { reResolveTrustOnResetDrift } from "../guardian-vellum-migration.js";
import { findLocalGuardianPrincipalId } from "../local-actor-identity.js";
import { resolveLocalPrincipalTrustContext } from "../local-principal-trust.js";

const log = getLogger("vellum-actor-trust");

export async function resolveVellumActorTrustContext(
  actorPrincipalId: string | undefined,
  opts?: {
    /**
     * Whether an "unknown" verdict may attempt the reset-drift repair
     * (`reResolveTrustOnResetDrift`). The repair WRITES to the local
     * principal mirror, so GET handlers must leave this off (safe methods
     * are side-effect-free); an unhealed drift then simply resolves as
     * "unknown" and the caller fail-closes until a mutating route heals it.
     */
    healResetDrift?: boolean;
  },
): Promise<TrustContext> {
  const sourceChannel = "vellum" as const;

  if (!actorPrincipalId) {
    return { trustClass: "guardian", sourceChannel };
  }

  // Dev-bypass injects a synthetic principal that won't match the real
  // guardian binding, so resolve the actual guardian principalId before
  // mapping trust.
  let principalId = actorPrincipalId;
  if (isHttpAuthDisabled() && actorPrincipalId === "dev-bypass") {
    principalId = (await findLocalGuardianPrincipalId()) ?? actorPrincipalId;
  }

  let trustCtx = await resolveLocalPrincipalTrustContext({
    actorPrincipalId: principalId,
    sourceChannel,
    conversationExternalId: "local",
  });
  if (trustCtx.trustClass === "unknown" && opts?.healResetDrift) {
    const healed = await reResolveTrustOnResetDrift(principalId, sourceChannel);
    if (healed) {
      trustCtx = healed;
      if (healed.trustClass !== "unknown") {
        log.info(
          { actorPrincipalId: principalId, trustClass: trustCtx.trustClass },
          "Trust re-resolved from local mirror after gateway reset drift",
        );
      }
    }
  }
  return trustCtx;
}
