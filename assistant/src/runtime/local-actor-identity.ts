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

import type { ChannelId } from '../channels/types.js';
import { buildIpcAuthContext } from '../daemon/ipc-handler.js';
import type { TrustContext } from '../daemon/session-runtime-assembly.js';
import { getActiveBinding } from '../memory/guardian-bindings.js';
import { getLogger } from '../util/logger.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from './assistant-scope.js';
import type { AuthContext } from './auth/types.js';
import { resolveTrustContext } from './trust-context-resolver.js';
import { ensureVellumGuardianBinding } from './guardian-vellum-migration.js';

const log = getLogger('local-actor-identity');

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
  sourceChannel: ChannelId = 'vellum',
): TrustContext {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const binding = getActiveBinding(assistantId, 'vellum');

  if (!binding) {
    // No vellum binding yet (pre-bootstrap). Eagerly create one so
    // downstream code that creates decisionable canonical requests
    // (tool_approval, pending_question) always has a guardianPrincipalId
    // available. Without this, createCanonicalGuardianRequest throws
    // IntegrityError and the request is silently dropped.
    log.debug('No vellum guardian binding found; bootstrapping binding for IPC');
    const principalId = ensureVellumGuardianBinding(assistantId);

    // Re-resolve through the shared pipeline now that the binding exists.
    const trustCtx = resolveTrustContext({
      assistantId,
      sourceChannel: 'vellum',
      conversationExternalId: 'local',
      actorExternalId: principalId,
    });
    // Overlay the caller's actual sourceChannel onto the resolved context.
    return { ...trustCtx, sourceChannel };
  }

  const guardianPrincipalId = binding.guardianExternalUserId;

  // Route through the shared trust resolution pipeline using 'vellum'
  // as the channel for binding lookup. The guardianPrincipalId comes
  // from the vellum binding, so the binding lookup must also target
  // 'vellum' — otherwise resolveActorTrust would look up a different
  // channel's binding (e.g. telegram/sms) and the IDs wouldn't match,
  // causing a 'unknown' trust classification.
  const trustCtx = resolveTrustContext({
    assistantId,
    sourceChannel: 'vellum',
    conversationExternalId: 'local',
    actorExternalId: guardianPrincipalId,
  });

  // Overlay the caller's actual sourceChannel onto the resolved context
  // so downstream consumers see the correct channel provenance.
  return { ...trustCtx, sourceChannel };
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
  const authContext = buildIpcAuthContext(sessionId);

  // Enrich with the guardian principal ID when a vellum binding exists,
  // so downstream guardian resolution can use authContext.actorPrincipalId.
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const binding = getActiveBinding(assistantId, 'vellum');
  if (binding) {
    return { ...authContext, actorPrincipalId: binding.guardianExternalUserId };
  }

  return authContext;
}
