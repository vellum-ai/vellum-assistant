/**
 * Derives a local principal's {@link TrustContext} from the gateway guardian
 * binding. Fails closed to unknown on a missing or null read.
 */

import type { ChannelId } from "../channels/types.js";
import { getGuardianDelivery } from "../contacts/guardian-delivery-reader.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";

export interface ResolveLocalPrincipalTrustInput {
  actorPrincipalId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
}

/** Guardian match → guardian ctx; miss or null read → unknown (fail closed). */
export async function resolveLocalPrincipalTrustContext(
  input: ResolveLocalPrincipalTrustInput,
): Promise<TrustContext> {
  const unknownContext: TrustContext = {
    sourceChannel: input.sourceChannel,
    trustClass: "unknown",
    requesterExternalUserId: input.actorPrincipalId,
    requesterChatId: input.conversationExternalId,
  };

  // Fail closed: a null read means the gateway is unreachable — never grant
  // guardian on a miss.
  const guardians = await getGuardianDelivery({ channelTypes: ["vellum"] });
  if (!guardians) return unknownContext;

  const guardian = guardians.find(
    (g) => g.principalId === input.actorPrincipalId,
  );
  if (!guardian) return unknownContext;

  return {
    sourceChannel: input.sourceChannel,
    trustClass: "guardian",
    guardianChatId: guardian.externalChatId ?? input.conversationExternalId,
    guardianExternalUserId:
      canonicalizeInboundIdentity(input.sourceChannel, guardian.address) ??
      undefined,
    guardianPrincipalId: guardian.principalId ?? undefined,
    // Mirror toTrustContext: with no username the requester identifier is the
    // canonical sender id, which for a vellum principal is actorPrincipalId.
    requesterIdentifier: input.actorPrincipalId,
    requesterExternalUserId: input.actorPrincipalId,
    requesterChatId: input.conversationExternalId,
  };
}
