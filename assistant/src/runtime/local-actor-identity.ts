/**
 * Deterministic local actor identity for local connections.
 *
 * Local connections come from the native app via local HTTP sessions.
 * No actor token is sent over the connection; instead, the daemon assigns a
 * deterministic local actor identity server-side by looking up the vellum
 * channel guardian binding.
 *
 * This routes local connections through the same `resolveTrustContext`
 * pathway used by HTTP channel ingress, producing equivalent
 * guardian-context behavior for the vellum channel.
 */

import type { ChannelId } from "../channels/types.js";
import { isHttpAuthDisabled } from "../config/env.js";
import { findGuardianForChannel } from "../contacts/contact-store.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { CURRENT_POLICY_EPOCH } from "./auth/policy.js";
import { resolveScopeProfile } from "./auth/scopes.js";
import type { AuthContext } from "./auth/types.js";
import { resolveTrustContext } from "./trust-context-resolver.js";

const log = getLogger("local-actor-identity");

/**
 * Build a synthetic AuthContext for a local session.
 *
 * Local connections are pre-authenticated via the daemon's file-system
 * permission model. This produces the same AuthContext shape that HTTP
 * routes receive from JWT verification, keeping downstream code
 * transport-agnostic.
 */
export function buildLocalAuthContext(conversationId: string): AuthContext {
  return {
    subject: `local:self:${conversationId}`,
    principalType: "local",
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    conversationId,
    scopeProfile: "local_v1",
    scopes: resolveScopeProfile("local_v1"),
    policyEpoch: CURRENT_POLICY_EPOCH,
  };
}

/**
 * Look up the local vellum guardian's principalId from the contacts table.
 *
 * Returns `undefined` when no vellum guardian binding exists (e.g. fresh
 * install before bootstrap). Callers should treat that case as
 * "not yet available" and either fall back or proceed without a principalId.
 */
export function findLocalGuardianPrincipalId(): string | undefined {
  return findGuardianForChannel("vellum")?.contact.principalId ?? undefined;
}

/**
 * Translate the synthetic dev-bypass actor principal to the real local
 * guardian's principalId when running in `DISABLE_HTTP_AUTH=true` mode.
 *
 * The dev-bypass `AuthContext` (`runtime/auth/middleware.ts`) injects
 * `"dev-bypass"` as the actor principal id for every request, but tool-side
 * trust resolution (`resolveLocalTrustContext`) and SSE registration both
 * carry the real local guardian principalId. Without this translation, every
 * targeted host_bash/host_file/host_cu/host_transfer result POST mismatches
 * the same-user check and is rejected with 403, and conversation/surface/
 * guardian-action routes resolve trust against the wrong principal.
 *
 * Returns the input unchanged when:
 *   - HTTP auth is enabled (production / non-dev-bypass deployments), OR
 *   - the input is not literally `"dev-bypass"` (e.g. service tokens).
 *
 * Returns the local guardian principalId when both gates are true. Returns
 * `undefined` when dev-bypass is set but no guardian binding has been created
 * yet (e.g. fresh install before bootstrap); callers must treat this the
 * same as a missing principal.
 */
export function resolveActorPrincipalIdForLocalGuardian(
  rawHeader: string | undefined,
): string | undefined {
  if (rawHeader !== "dev-bypass" || !isHttpAuthDisabled()) return rawHeader;

  const guardianPrincipalId = findLocalGuardianPrincipalId();
  if (guardianPrincipalId) return guardianPrincipalId;

  log.warn(
    "dev-bypass actor principal received but no vellum guardian binding found; returning undefined",
  );
  return undefined;
}

/**
 * Resolve the guardian runtime context for a local connection.
 *
 * Looks up the vellum guardian binding to obtain the `guardianPrincipalId`,
 * then passes it as the sender identity through `resolveTrustContext` --
 * the same pathway HTTP channel routes use. This ensures local and HTTP
 * produce equivalent trust classification for the vellum channel.
 *
 * When no vellum guardian binding exists (e.g. fresh install before
 * bootstrap), falls back to a minimal guardian context so the local
 * user is not incorrectly denied.
 */
export function resolveLocalTrustContext(
  sourceChannel: ChannelId = "vellum",
): TrustContext {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;

  const guardianPrincipalId = findLocalGuardianPrincipalId();
  if (guardianPrincipalId) {
    const trustCtx = resolveTrustContext({
      assistantId,
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: guardianPrincipalId,
    });
    return { ...trustCtx, sourceChannel };
  }

  log.warn(
    "No vellum guardian binding found — gateway may not have started yet; falling back to minimal trust context",
  );
  const trustCtx = resolveTrustContext({
    assistantId,
    sourceChannel: "vellum",
    conversationExternalId: "local",
    actorExternalId: "local",
  });
  return { ...trustCtx, sourceChannel };
}

/**
 * Build an AuthContext for a local connection.
 *
 * Produces the same AuthContext shape that HTTP routes receive from JWT
 * verification, using the `local_v1` scope profile. The `actorPrincipalId`
 * is populated from the vellum guardian binding when available, enabling
 * downstream code to resolve guardian context using the same
 * `authContext.actorPrincipalId` path as HTTP sessions.
 */
export function resolveLocalAuthContext(conversationId: string): AuthContext {
  const authContext = buildLocalAuthContext(conversationId);

  const guardianPrincipalId = findLocalGuardianPrincipalId();
  if (guardianPrincipalId) {
    return { ...authContext, actorPrincipalId: guardianPrincipalId };
  }

  log.warn(
    "No vellum guardian binding found — gateway may not have started yet; returning without actorPrincipalId",
  );
  return authContext;
}
