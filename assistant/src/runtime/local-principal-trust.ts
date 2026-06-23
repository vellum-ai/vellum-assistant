/**
 * Local-principal trust mapper.
 *
 * Derives a local principal's runtime {@link TrustContext} from the gateway
 * guardian binding instead of the assistant DB. A `vellum` principal is the
 * guardian (owner) or nobody, so "trust of this principal on the vellum
 * channel" reduces to "does `actorPrincipalId` match the gateway guardian's
 * principalId?" — which {@link getGuardianDelivery} answers.
 *
 * The mapper is pure: it does not heal binding drift or read local ACL. The
 * routes own the heal/re-resolve loop and call this mapper.
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

/**
 * Resolve the trust context for a local principal from the gateway guardian
 * binding. Guardian match → guardian ctx; otherwise → unknown. A null gateway
 * read fails closed to unknown rather than granting guardian on a miss.
 */
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
