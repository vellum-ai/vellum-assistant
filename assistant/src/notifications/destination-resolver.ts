/**
 * Resolves per-channel destination endpoints for notification delivery.
 *
 * Reads guardian delivery info from the gateway-backed guardian list.
 *
 * - Vellum: no external endpoint needed — delivery goes through the event
 *   broadcast mechanism to connected desktop/mobile clients. The
 *   guardianPrincipalId is included in metadata so downstream adapters
 *   can scope guardian-sensitive notifications to bound guardian devices.
 * - Binding-based channels (telegram): require a chat/delivery ID
 *   sourced from the guardian contact's channel record.
 */

import type { GuardianDelivery } from "@vellumai/gateway-client";

import { isNotificationDeliverable } from "../channels/config.js";
import type { ChannelId } from "../channels/types.js";
import { guardianForChannel } from "../contacts/guardian-delivery-reader.js";
import { getLogger } from "../util/logger.js";
import type { ChannelDestination, NotificationChannel } from "./types.js";

const log = getLogger("destination-resolver");

/** Guardian delivery endpoint for a channel, flattened from either source. */
interface ResolvedGuardian {
  principalId?: string;
  address: string;
  externalChatId?: string;
}

/** Resolve the guardian delivery endpoint for a channel from the gateway list. */
function resolveGuardian(
  guardians: GuardianDelivery[] | null,
  channelType: string,
): ResolvedGuardian | undefined {
  const g = guardians
    ? guardianForChannel(guardians, channelType)
    : undefined;
  if (!g) return undefined;
  return {
    principalId: g.principalId ?? undefined,
    address: g.address,
    externalChatId: g.externalChatId ?? undefined,
  };
}

/**
 * Resolve destination information for each requested channel.
 *
 * Accepts the broad `ChannelId` union so that callers can pass any channel;
 * the function skips non-deliverable channels via `isNotificationDeliverable`.
 * Returns a map keyed by `NotificationChannel`. Channels that cannot be
 * resolved (e.g. no Telegram binding configured) are omitted from the result.
 *
 * `guardians` is the gateway-resolved guardian list; a channel with no entry
 * in the list is omitted from the result.
 */
export function resolveDestinations(
  channels: readonly (ChannelId | NotificationChannel)[],
  guardians: GuardianDelivery[] | null,
): Map<NotificationChannel, ChannelDestination> {
  const result = new Map<NotificationChannel, ChannelDestination>();

  for (const channel of channels) {
    if (!isNotificationDeliverable(channel)) continue;

    // After the deliverability check, `channel` is guaranteed to be a
    // NotificationChannel — TypeScript cannot infer this from the runtime
    // guard, so we narrow with a switch over known deliverable values.
    switch (channel as NotificationChannel) {
      case "vellum": {
        // Vellum delivery is local — no external endpoint required.
        // Include the guardianPrincipalId so the adapter can annotate
        // guardian-sensitive notifications for scoped delivery.
        const guardian = resolveGuardian(guardians, "vellum");
        const metadata: Record<string, unknown> = {};
        if (guardian?.principalId) {
          metadata.guardianPrincipalId = guardian.principalId;
        }
        result.set("vellum", {
          channel: "vellum",
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
        log.debug(
          {
            channel: "vellum",
            source: "guardian-delivery",
            hasEndpoint: false,
          },
          "destination resolved",
        );
        break;
      }
      case "telegram": {
        const guardian = resolveGuardian(guardians, channel);
        if (guardian?.externalChatId) {
          const externalChatId = guardian.externalChatId;
          result.set(channel as NotificationChannel, {
            channel: channel as NotificationChannel,
            endpoint: externalChatId,
            metadata: {
              externalUserId: guardian.address,
            },
            bindingContext: {
              sourceChannel: channel as NotificationChannel,
              externalChatId,
              externalUserId: guardian.address,
            },
          });
        }
        log.debug(
          {
            channel,
            source: "guardian-delivery",
            hasEndpoint: !!guardian?.externalChatId,
          },
          "destination resolved",
        );
        break;
      }
      case "slack": {
        const guardian = resolveGuardian(guardians, "slack");
        const chatId = guardian?.externalChatId;
        // Slack bindings can originate from app_mention in shared channels.
        // Only route notifications to DM channels (IDs starting with "D")
        // to prevent leaking notifications into shared workspaces.
        if (guardian && chatId && isSlackDmChannel(chatId)) {
          result.set("slack", {
            channel: "slack",
            endpoint: chatId,
            metadata: {
              externalUserId: guardian.address,
            },
            bindingContext: {
              sourceChannel: "slack",
              externalChatId: chatId,
              externalUserId: guardian.address,
            },
          });
        } else if (guardian && chatId) {
          log.warn(
            { channel: "slack", chatId },
            "skipping non-DM Slack channel for notification delivery",
          );
        }
        log.debug(
          {
            channel: "slack",
            source: "guardian-delivery",
            hasEndpoint: !!(chatId && isSlackDmChannel(chatId)),
          },
          "destination resolved",
        );
        break;
      }
      case "platform": {
        // Platform delivery goes through the daemon's VellumPlatformClient —
        // no external binding needed. Include guardianPrincipalId so the
        // adapter can scope guardian-sensitive notifications.
        const platformGuardian = resolveGuardian(guardians, "vellum");
        const platformMeta: Record<string, unknown> = {};
        if (platformGuardian?.principalId) {
          platformMeta.guardianPrincipalId = platformGuardian.principalId;
        }
        result.set("platform", {
          channel: "platform",
          metadata:
            Object.keys(platformMeta).length > 0 ? platformMeta : undefined,
        });
        log.debug(
          { channel: "platform", source: "guardian-delivery", hasEndpoint: false },
          "destination resolved",
        );
        break;
      }
      default: {
        // Future deliverable channels without a resolver — skip silently.
        break;
      }
    }
  }

  return result;
}

/**
 * Slack DM channel IDs start with "D". Channels starting with "C" are
 * public/shared channels, "G" are legacy group DMs. We restrict proactive
 * notification delivery to "D"-prefixed IDs to avoid leaking into shared
 * channels where app_mention bindings may have been created.
 */
function isSlackDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}
