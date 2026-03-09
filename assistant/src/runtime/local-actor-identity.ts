/**
 * Deterministic local actor identity for IPC connections.
 *
 * IPC (Unix domain socket) connections come from the local macOS native app.
 * No actor token is sent over the socket; instead, the daemon assigns a
 * deterministic local actor identity server-side by looking up the vellum
 * channel guardian binding.
 *
 * This routes IPC connections through the same `resolveTrustContext`
 * pathway used by HTTP channel ingress, producing equivalent
 * guardian-context behavior for the vellum channel.
 */

import type { ChannelId } from "../channels/types.js";
import { findGuardianForChannel } from "../contacts/contact-store.js";
import type { TrustContext } from "../daemon/session-runtime-assembly.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { CURRENT_POLICY_EPOCH } from "./auth/policy.js";
import { resolveScopeProfile } from "./auth/scopes.js";
import type { AuthContext } from "./auth/types.js";
import { ensureVellumGuardianBinding } from "./guardian-vellum-migration.js";
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
export function buildLocalAuthContext(sessionId: string): AuthContext {
  return {
    subject: `ipc:self:${sessionId}`,
    principalType: "ipc",
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    sessionId,
    scopeProfile: "ipc_v1",
    scopes: resolveScopeProfile("ipc_v1"),
    policyEpoch: CURRENT_POLICY_EPOCH,
  };
}

/**
 * @deprecated Use `buildLocalAuthContext` instead.
 */
export const buildIpcAuthContext = buildLocalAuthContext;

/**
 * Resolve the guardian runtime context for a local IPC connection.
 *
 * Looks up the vellum guardian binding to obtain the `guardianPrincipalId`,
 * then passes it as the sender identity through `resolveTrustContext` --
 * the same pathway HTTP channel routes use. This ensures IPC and HTTP
 * produce equivalent trust classification for the vellum channel.
 *
 * When no vellum guardian binding exists (e.g. fresh install before
 * bootstrap), falls back to a minimal guardian context so the local
 * user is not incorrectly denied.
 */
export function resolveLocalIpcTrustContext(
  sourceChannel: ChannelId = "vellum",
): TrustContext {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;

  // Try contacts-first for the vellum guardian channel
  const guardianResult = findGuardianForChannel("vellum");
  if (guardianResult && guardianResult.contact.principalId) {
    const guardianPrincipalId = guardianResult.contact.principalId;
    const trustCtx = resolveTrustContext({
      assistantId,
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: guardianPrincipalId,
    });
    return { ...trustCtx, sourceChannel };
  }

  // No guardian contact with a principalId — bootstrap via ensureVellumGuardianBinding
  // to self-heal (creates the binding + contact if missing).
  log.debug("No vellum guardian contact found; bootstrapping binding for IPC");
  try {
    const principalId = ensureVellumGuardianBinding(assistantId);
    const trustCtx = resolveTrustContext({
      assistantId,
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: principalId,
    });
    return { ...trustCtx, sourceChannel };
  } catch (err) {
    log.warn(
      { err },
      "Self-heal ensureVellumGuardianBinding failed — falling back to minimal trust context",
    );
    const trustCtx = resolveTrustContext({
      assistantId,
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: "local",
    });
    return { ...trustCtx, sourceChannel };
  }
}

/**
 * Build an AuthContext for a local IPC connection.
 *
 * Produces the same AuthContext shape that HTTP routes receive from JWT
 * verification, using the `ipc_v1` scope profile. The `actorPrincipalId`
 * is populated from the vellum guardian binding when available, enabling
 * downstream code to resolve guardian context using the same
 * `authContext.actorPrincipalId` path as HTTP sessions.
 */
export function resolveLocalIpcAuthContext(sessionId: string): AuthContext {
  const authContext = buildLocalAuthContext(sessionId);

  // Enrich with the guardian principal ID from contacts-first path
  const guardianResult = findGuardianForChannel("vellum");
  if (guardianResult && guardianResult.contact.principalId) {
    return {
      ...authContext,
      actorPrincipalId: guardianResult.contact.principalId,
    };
  }

  // Self-heal: no guardian contact with principalId — bootstrap via
  // ensureVellumGuardianBinding (mirrors resolveLocalIpcTrustContext).
  try {
    log.debug(
      "No vellum guardian contact found; bootstrapping binding for IPC auth",
    );
    const principalId = ensureVellumGuardianBinding(authContext.assistantId);
    return { ...authContext, actorPrincipalId: principalId };
  } catch (err) {
    log.warn(
      { err },
      "Self-heal ensureVellumGuardianBinding failed in auth context — returning without actorPrincipalId",
    );
  }

  return authContext;
}
