/**
 * Deterministic local actor identity for IPC connections.
 *
 * IPC (Unix domain socket) connections come from the local macOS native app.
 * No actor token is sent over the socket; instead, the daemon assigns a
 * deterministic local actor identity server-side by looking up the vellum
 * channel guardian binding.
 *
 * This routes IPC connections through the same `resolveGuardianContext`
 * pathway used by HTTP channel ingress, producing equivalent
 * guardian-context behavior for the vellum channel.
 */

import type { ChannelId } from '../channels/types.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import { getActiveBinding } from '../memory/guardian-bindings.js';
import { getLogger } from '../util/logger.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from './assistant-scope.js';
import {
  resolveGuardianContext,
  toGuardianRuntimeContext,
} from './guardian-context-resolver.js';

const log = getLogger('local-actor-identity');

/**
 * Resolve the guardian runtime context for a local IPC connection.
 *
 * Looks up the vellum guardian binding to obtain the `guardianPrincipalId`,
 * then passes it as the sender identity through `resolveGuardianContext` --
 * the same pathway HTTP channel routes use. This ensures IPC and HTTP
 * produce equivalent trust classification for the vellum channel.
 *
 * When no vellum guardian binding exists (e.g. fresh install before
 * bootstrap), falls back to a minimal guardian context so the local
 * user is not incorrectly denied.
 */
export function resolveLocalIpcGuardianContext(
  sourceChannel: ChannelId = 'vellum',
): GuardianRuntimeContext {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const binding = getActiveBinding(assistantId, 'vellum');

  if (!binding) {
    // No vellum binding yet (pre-bootstrap). The local user is
    // inherently the guardian of their own machine, so produce a
    // guardian context without a binding match. The trust resolver
    // would classify this as 'unknown' due to no_binding, but for
    // the local IPC case that is incorrect -- the local macOS user
    // is always the guardian.
    log.debug('No vellum guardian binding found; using fallback guardian context for IPC');
    return {
      sourceChannel,
      trustClass: 'guardian',
    };
  }

  const guardianPrincipalId = binding.guardianExternalUserId;

  // Route through the shared trust resolution pipeline using 'vellum'
  // as the channel for binding lookup. The guardianPrincipalId comes
  // from the vellum binding, so the binding lookup must also target
  // 'vellum' — otherwise resolveActorTrust would look up a different
  // channel's binding (e.g. telegram/sms) and the IDs wouldn't match,
  // causing a 'unknown' trust classification.
  const guardianCtx = resolveGuardianContext({
    assistantId,
    sourceChannel: 'vellum',
    externalChatId: 'local',
    senderExternalUserId: guardianPrincipalId,
  });

  // Overlay the caller's actual sourceChannel onto the resolved context
  // so downstream consumers see the correct channel provenance.
  return toGuardianRuntimeContext(sourceChannel, guardianCtx);
}
