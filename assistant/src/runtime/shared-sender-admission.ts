/**
 * Whether a trusted contact may send into a conversation shared with them.
 *
 * Read when the message arrives and again when a queued message is about to
 * run, so a contact removed or revoked while their message waited never gets
 * a turn. Trust is read fresh from the gateway on `vellum-shared` with the
 * channel admission floor applied, and anything short of an admitted trusted
 * contact is refused.
 */

import type { TrustContext } from "../daemon/trust-context-types.js";
import { isParticipant } from "../persistence/conversation-participants.js";
import {
  PluginTurnNotAdmittedError,
  resolvePluginChannelTurnTrust,
} from "../plugin-api/plugin-channel-turn-trust.js";

/** The contact's own trust, or null when they are not admitted. */
export async function resolveSharedSenderTrust(
  principalId: string,
): Promise<TrustContext | null> {
  let trust: TrustContext;
  try {
    trust = await resolvePluginChannelTurnTrust({
      sourceChannel: "vellum-shared",
      externalChatId: principalId,
      externalUserId: principalId,
    });
  } catch (err) {
    if (err instanceof PluginTurnNotAdmittedError) {
      return null;
    }
    throw err;
  }
  return trust.trustClass === "trusted_contact" ? trust : null;
}

/** Whether the contact is still a live participant and still admitted. */
export async function isSharedSenderAdmitted(
  conversationId: string,
  principalId: string,
): Promise<boolean> {
  if (!isParticipant(conversationId, principalId)) {
    return false;
  }
  return (await resolveSharedSenderTrust(principalId)) !== null;
}
