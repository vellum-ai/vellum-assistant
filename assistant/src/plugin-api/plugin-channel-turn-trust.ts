/**
 * Gateway admission and trust for plugin turns addressed by a channel chat.
 *
 * A channel address means an inbound sender, not an internal plugin job.
 * Trust comes from the gateway verdict (`resolve_inbound_trust`); the turn
 * runs only when that sender clears the channel admission floor.
 */

import { meetsAdmissionFloor } from "@vellumai/gateway-client";

import { readInboundTrust } from "../calls/inbound-trust-reader.js";
import type { ChannelId } from "../channels/types.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { trustContextFromVerdict } from "../runtime/trust-verdict-consumer.js";

interface PluginChannelTurnAddress {
  sourceChannel: ChannelId;
  externalChatId: string;
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
}

export class PluginTurnNotAdmittedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`This inbound plugin turn was not admitted (${reason}).`);
    this.name = "PluginTurnNotAdmittedError";
    this.reason = reason;
  }
}

export async function resolvePluginChannelTurnTrust(
  channel: PluginChannelTurnAddress,
): Promise<TrustContext> {
  const actorExternalId = channel.externalUserId?.trim() || undefined;
  const read = await readInboundTrust({
    channelType: channel.sourceChannel,
    actorExternalId,
  });
  if (!read.ok) {
    throw new PluginTurnNotAdmittedError("trust_resolution_failed");
  }

  if (read.verdict.resolutionFailed) {
    throw new PluginTurnNotAdmittedError("trust_resolution_failed");
  }

  const memberStatus = read.verdict.status;
  if (memberStatus === "blocked" || memberStatus === "revoked") {
    throw new PluginTurnNotAdmittedError(`member_${memberStatus}`);
  }

  const trustClass = read.verdict.trustClass;
  if (
    read.admissionPolicy != null &&
    !meetsAdmissionFloor(read.admissionPolicy, trustClass)
  ) {
    throw new PluginTurnNotAdmittedError(
      `admission_policy_${read.admissionPolicy}`,
    );
  }

  return trustContextFromVerdict(read.verdict, {
    sourceChannel: channel.sourceChannel,
    conversationExternalId: channel.externalChatId,
    actorDisplayName: channel.displayName ?? undefined,
    actorUsername: channel.username ?? undefined,
  });
}
