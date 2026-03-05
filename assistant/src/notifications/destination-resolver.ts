/**
 * Resolves per-channel destination endpoints for notification delivery.
 *
 * Reads guardian delivery info from the contacts table.
 *
 * - Vellum: no external endpoint needed — delivery goes through the IPC
 *   broadcast mechanism to connected desktop/mobile clients. The
 *   guardianPrincipalId is included in metadata so downstream adapters
 *   can scope guardian-sensitive notifications to bound guardian devices.
 * - Binding-based channels (telegram, sms): require a chat/delivery ID
 *   sourced from the guardian contact's channel record.
 */

import { isNotificationDeliverable } from "../channels/config.js";
import type { ChannelId } from "../channels/types.js";
import { findGuardianForChannel } from "../contacts/contact-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "../util/logger.js";
import type { ChannelDestination, NotificationChannel } from "./types.js";

const log = getLogger("destination-resolver");

/**
 * Resolve destination information for each requested channel.
 *
 * Accepts the broad `ChannelId` union so that callers can pass any channel;
 * the function skips non-deliverable channels via `isNotificationDeliverable`.
 * Returns a map keyed by `NotificationChannel`. Channels that cannot be
 * resolved (e.g. no Telegram binding configured) are omitted from the result.
 */
export function resolveDestinations(
  channels: readonly (ChannelId | NotificationChannel)[],
): Map<NotificationChannel, ChannelDestination> {
  const result = new Map<NotificationChannel, ChannelDestination>();

  for (const channel of channels) {
    if (!isNotificationDeliverable(channel)) continue;

    // After the deliverability check, `channel` is guaranteed to be a
    // NotificationChannel — TypeScript cannot infer this from the runtime
    // guard, so we narrow with a switch over known deliverable values.
    switch (channel as NotificationChannel) {
      case "vellum": {
        // Vellum delivery is local IPC — no external endpoint required.
        // Include the guardianPrincipalId so the adapter can annotate
        // guardian-sensitive notifications for scoped delivery.
        const guardianResult = findGuardianForChannel(
          "vellum",
          DAEMON_INTERNAL_ASSISTANT_ID,
        );
        const metadata: Record<string, unknown> = {};
        if (guardianResult) {
          metadata.guardianPrincipalId = guardianResult.contact.principalId;
        }
        result.set("vellum", {
          channel: "vellum",
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
        log.debug(
          {
            channel: "vellum",
            source: "contacts",
            hasEndpoint: false,
          },
          "destination resolved",
        );
        break;
      }
      case "telegram":
      case "sms":
      case "slack": {
        const guardianResult = findGuardianForChannel(
          channel,
          DAEMON_INTERNAL_ASSISTANT_ID,
        );
        if (guardianResult && guardianResult.channel.externalChatId) {
          result.set(channel as NotificationChannel, {
            channel: channel as NotificationChannel,
            endpoint: guardianResult.channel.externalChatId ?? undefined,
            metadata: {
              externalUserId: guardianResult.channel.externalUserId,
            },
          });
        }
        log.debug(
          {
            channel,
            source: "contacts",
            hasEndpoint: !!guardianResult?.channel.externalChatId,
          },
          "destination resolved",
        );
        break;
      }
      case "slack": {
        const guardianResult = findGuardianForChannel(
          "slack",
          DAEMON_INTERNAL_ASSISTANT_ID,
        );
        const chatId = guardianResult?.channel.externalChatId;
        // Slack bindings can originate from app_mention in shared channels.
        // Only route notifications to DM channels (IDs starting with "D")
        // to prevent leaking notifications into shared workspaces.
        if (guardianResult && chatId && isSlackDmChannel(chatId)) {
          result.set("slack", {
            channel: "slack",
            endpoint: chatId,
            metadata: {
              externalUserId: guardianResult.channel.externalUserId,
            },
          });
        } else if (guardianResult && chatId) {
          log.warn(
            { channel: "slack", chatId },
            "skipping non-DM Slack channel for notification delivery",
          );
        }
        log.debug(
          {
            channel: "slack",
            source: "contacts",
            hasEndpoint: !!(chatId && isSlackDmChannel(chatId)),
          },
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
