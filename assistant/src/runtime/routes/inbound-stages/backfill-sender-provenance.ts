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
 * guardian-address comparison and carries no contact id.
 */

import { readInboundTrust } from "../../../calls/inbound-trust-reader.js";
import type { Message as ProviderMessage } from "../../../messaging/provider-types.js";
import { inboundIdentitiesMatch } from "../../../util/canonicalize-identity.js";
import type { TrustClass } from "../../trust-class.js";
import {
  verdictMemberFromVerdict,
  verdictUsability,
} from "../../trust-verdict-consumer.js";

export interface BackfilledSenderProvenance {
  provenanceTrustClass: TrustClass;
  provenanceContactId?: string;
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
  // Reads for people's rows start together, so the pass waits on the slowest
  // read rather than on their sum. A row Slack does not flag as a bot is
  // always a person's row. A read reports failure as a result, never a
  // rejection, so nothing here goes unhandled.
  for (const message of messages) {
    if (message.metadata?.isBot !== true) {
      void resolve(message.sender?.id);
    }
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
  };
}
