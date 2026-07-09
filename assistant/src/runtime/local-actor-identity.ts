/**
 * Deterministic local actor identity for local connections.
 *
 * Local connections come from the native app via local HTTP sessions.
 * No actor token is sent over the connection; instead, the daemon assigns a
 * deterministic local actor identity server-side by looking up the vellum
 * channel guardian binding — the same gateway-owned binding
 * `resolveLocalPrincipalTrustContext` maps trust from.
 */

import { isHttpAuthDisabled } from "../config/env.js";
import {
  getGuardianDelivery,
  guardianForChannel,
  peekCachedGuardianDelivery,
} from "../contacts/guardian-delivery-reader.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { CURRENT_POLICY_EPOCH } from "./auth/policy.js";
import { resolveScopeProfile } from "./auth/scopes.js";
import type { AuthContext } from "./auth/types.js";

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
 * Resolve the local vellum guardian's principalId from the gateway.
 *
 * The gateway owns guardian binding; this reads it through the cached
 * `getGuardianDelivery` reader (PR-3 TTL + single-flight) so hot paths don't
 * storm the IPC.
 *
 * Returns `undefined` when no vellum guardian binding exists (e.g. fresh
 * install before bootstrap, or the gateway is unreachable). Callers should
 * treat that case as "not yet available" and proceed without a principalId.
 */
export async function findLocalGuardianPrincipalId(): Promise<
  string | undefined
> {
  const list = await getGuardianDelivery({ channelTypes: ["vellum"] });
  if (!list) return undefined;
  return guardianForChannel(list, "vellum")?.principalId ?? undefined;
}

/**
 * Resolve a decidable guardian principal for canonical guardian-request
 * creation: the channel binding's principal when present, else the vellum
 * anchor principal (the adopt/repair path for guardian rows that carry no
 * principal). A falsy binding principal (`null` or `""`) is unresolved by
 * contract — decisionable requests must never be created with an empty
 * principal, so callers fail closed on `undefined`.
 */
export async function resolveDecidableGuardianPrincipalId(
  bindingPrincipalId: string | null,
): Promise<string | undefined> {
  return bindingPrincipalId || (await findLocalGuardianPrincipalId());
}

/**
 * Eagerly warm the gateway guardian-delivery cache for the vellum channel.
 *
 * The SSE eager-subscribe path resolves the actor principal synchronously via
 * {@link findLocalGuardianPrincipalIdFromStore}, which reads only the IO-free
 * cache snapshot. On a cold cache (auth-disabled / local startup, before any
 * async `getGuardianDelivery` has run) it returns undefined, so the FIRST SSE
 * registration would carry no `actorPrincipalId` and host-proxy same-user
 * targeting would regress until a later reconnect warms the cache.
 *
 * Called during daemon startup (after the gateway IPC is reachable) so the
 * cache is populated before clients register. Best-effort: a cold gateway
 * leaves the cache empty (failures aren't cached), and the async hot paths
 * warm it on their next read.
 */
export async function warmLocalGuardianPrincipalCache(): Promise<void> {
  await findLocalGuardianPrincipalId();
}

/**
 * Synchronous read of the vellum guardian's principalId for paths that cannot
 * await {@link findLocalGuardianPrincipalId} — namely the SSE eager-subscribe
 * path (`events-routes`), which registers before the stream is created.
 *
 * Reads the same gateway-owned binding as the async path via a sync, IO-free
 * snapshot of the guardian-delivery cache (kept fresh by the async hot paths
 * and event-driven invalidation), so SSE registers the SAME principal the
 * send/result routes resolve.
 */
export function findLocalGuardianPrincipalIdFromStore(): string | undefined {
  const cached = peekCachedGuardianDelivery({ channelTypes: ["vellum"] });
  if (!cached) return undefined;
  return guardianForChannel(cached, "vellum")?.principalId ?? undefined;
}

/**
 * Translate the synthetic dev-bypass actor principal to the real local
 * guardian's principalId when running in `DISABLE_HTTP_AUTH=true` mode.
 *
 * The dev-bypass `AuthContext` (`runtime/auth/middleware.ts`) injects
 * `"dev-bypass"` as the actor principal id for every request, but trust
 * resolution (`resolveLocalPrincipalTrustContext`) and SSE registration both
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
export async function resolveActorPrincipalIdForLocalGuardian(
  rawHeader: string | undefined,
): Promise<string | undefined> {
  if (rawHeader !== "dev-bypass" || !isHttpAuthDisabled()) return rawHeader;

  const guardianPrincipalId = await findLocalGuardianPrincipalId();
  if (guardianPrincipalId) return guardianPrincipalId;

  log.warn(
    "dev-bypass actor principal received but no vellum guardian binding found; returning undefined",
  );
  return undefined;
}

/**
 * Synchronous variant of {@link resolveActorPrincipalIdForLocalGuardian} for
 * the SSE eager-subscribe path, which registers before the response stream is
 * created and cannot await. Resolves the guardian from the IO-free gateway
 * cache snapshot first (same source the async path reads), falling back to the
 * local store when the cache is cold — so SSE registers the SAME principal the
 * send/result routes resolve and host-proxy targeting matches the same-user
 * client even when the local contact row is stale.
 */
export function resolveActorPrincipalIdForLocalGuardianSync(
  rawHeader: string | undefined,
): string | undefined {
  if (rawHeader !== "dev-bypass" || !isHttpAuthDisabled()) return rawHeader;

  const guardianPrincipalId = findLocalGuardianPrincipalIdFromStore();
  if (guardianPrincipalId) return guardianPrincipalId;

  log.warn(
    "dev-bypass actor principal received but no vellum guardian binding found; returning undefined",
  );
  return undefined;
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
export async function resolveLocalAuthContext(
  conversationId: string,
): Promise<AuthContext> {
  const authContext = buildLocalAuthContext(conversationId);

  const guardianPrincipalId = await findLocalGuardianPrincipalId();
  if (guardianPrincipalId) {
    return { ...authContext, actorPrincipalId: guardianPrincipalId };
  }

  log.warn(
    "No vellum guardian binding found — gateway may not have started yet; returning without actorPrincipalId",
  );
  return authContext;
}
