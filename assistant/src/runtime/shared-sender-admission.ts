/**
 * Whether a trusted contact may send into a conversation shared with them.
 *
 * Read when the message arrives and again when a queued message is about to
 * run, so a contact removed or revoked while their message waited never gets
 * a turn. Trust is read fresh from the gateway on `vellum-shared` with the
 * channel admission floor applied.
 *
 * The answer has three outcomes because "denied" and "could not be checked"
 * call for different handling: a denial is final, while a read that failed
 * says nothing about the contact and can be asked again.
 */

import type { TrustContext } from "../daemon/trust-context-types.js";
import { isParticipant } from "../persistence/conversation-participants.js";
import {
  PluginTurnNotAdmittedError,
  resolvePluginChannelTurnTrust,
} from "../plugin-api/plugin-channel-turn-trust.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("shared-sender-admission");

/** The admission reason the trust read gives when it could not vouch. */
const UNVERIFIABLE_REASON = "trust_resolution_failed";

export type SharedSenderAdmission =
  | { outcome: "admitted"; trust: TrustContext }
  | { outcome: "denied" }
  | { outcome: "unverifiable" };

async function readSharedSenderTrust(
  principalId: string,
): Promise<SharedSenderAdmission> {
  let trust: TrustContext;
  try {
    trust = await resolvePluginChannelTurnTrust({
      sourceChannel: "vellum-shared",
      externalChatId: principalId,
      externalUserId: principalId,
    });
  } catch (err) {
    if (
      err instanceof PluginTurnNotAdmittedError &&
      err.reason !== UNVERIFIABLE_REASON
    ) {
      return { outcome: "denied" };
    }
    log.warn({ err, principalId }, "Shared sender trust could not be read");
    return { outcome: "unverifiable" };
  }
  return trust.trustClass === "trusted_contact"
    ? { outcome: "admitted", trust }
    : { outcome: "denied" };
}

/**
 * The contact's own trust, or null when they are not admitted or their trust
 * could not be read. For a sender whose message has not been accepted yet,
 * where both answers refuse it.
 */
export async function resolveSharedSenderTrust(
  principalId: string,
): Promise<TrustContext | null> {
  const admission = await readSharedSenderTrust(principalId);
  return admission.outcome === "admitted" ? admission.trust : null;
}

/** Whether the contact is still a live participant and still admitted. */
export async function checkSharedSender(
  conversationId: string,
  principalId: string,
): Promise<SharedSenderAdmission> {
  if (!principalId || !isParticipant(conversationId, principalId)) {
    return { outcome: "denied" };
  }
  return readSharedSenderTrust(principalId);
}
