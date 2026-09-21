/**
 * Provenance for backfilled Slack rows, resolved per sender.
 *
 * A backfilled row was written by someone other than the live inbound actor,
 * so the live turn's trust context says nothing about it. Each sender is
 * classified by the same gateway verdict live ingress uses
 * (`resolve_inbound_trust`), so a backfilled row and a live row from the same
 * person carry the same trust class and contact id. The verdict answers for
 * the contact list at import time, which is when the row is written.
 *
 * When the verdict is unreadable or unusable, the row falls back to the
 * guardian-address comparison, carries no contact id, and is marked
 * `provenanceLookupFailed` so it stays distinguishable from a stranger.
 *
 * A read goes through `readInboundTrust`, so it also refreshes the
 * member-verdict cache for that sender, as a live inbound read does.
 */

import { readInboundTrust } from "../../../calls/inbound-trust-reader.js";
import type { ActorAuthorProvenance } from "../../../daemon/message-provenance.js";
import type { Message as ProviderMessage } from "../../../messaging/provider-types.js";
import { inboundIdentitiesMatch } from "../../../util/canonicalize-identity.js";
import type { TrustClass } from "../../trust-class.js";
import {
  verdictMemberFromVerdict,
  verdictUsability,
} from "../../trust-verdict-consumer.js";

export interface BackfilledSenderProvenance extends ActorAuthorProvenance {
  provenanceTrustClass: TrustClass;
  /** The lookup ran and returned no usable verdict; see `messageMetadataSchema`. */
  provenanceLookupFailed?: true;
}

/**
 * Resolves a backfilled message's sender provenance. One resolver serves one
 * backfill pass and reads the gateway at most once per distinct sender.
 */
export type BackfilledSenderProvenanceResolver = (
  senderId: string | undefined,
) => Promise<BackfilledSenderProvenance>;

export function createBackfilledSenderProvenanceResolver(
  guardianExternalUserId: string | undefined,
  messages: readonly ProviderMessage[],
): BackfilledSenderProvenanceResolver {
  const bySender = new Map<string, Promise<BackfilledSenderProvenance>>();
  const resolve: BackfilledSenderProvenanceResolver = (senderId) => {
    const trimmed = senderId?.trim();
    if (!trimmed) {
      return Promise.resolve({ provenanceTrustClass: "unknown" });
    }
    let pending = bySender.get(trimmed);
    if (!pending) {
      pending = resolveSenderProvenance(trimmed, guardianExternalUserId);
      bySender.set(trimmed, pending);
    }
    return pending;
  };
  // Every sender's read starts now, so the pass waits on the slowest read
  // rather than their sum. Bots included: a third-party bot's post is a user
  // row, and singling out this assistant's own posts needs an async lookup.
  // A read reports failure as a result, never a rejection.
  for (const message of messages) {
    void resolve(message.sender?.id);
  }
  return resolve;
}

async function resolveSenderProvenance(
  senderId: string,
  guardianExternalUserId: string | undefined,
): Promise<BackfilledSenderProvenance> {
  const read = await readInboundTrust({
    channelType: "slack",
    actorExternalId: senderId,
  });
  if (read.ok) {
    const usability = verdictUsability(read.verdict);
    if (usability.usable) {
      const member = verdictMemberFromVerdict(usability.verdict);
      return {
        provenanceTrustClass: usability.verdict.trustClass,
        ...(member ? { provenanceContactId: member.contactId } : {}),
      };
    }
  }
  return {
    provenanceTrustClass:
      guardianExternalUserId !== undefined &&
      inboundIdentitiesMatch("slack", senderId, guardianExternalUserId)
        ? "guardian"
        : "unknown",
    provenanceLookupFailed: true,
  };
}
