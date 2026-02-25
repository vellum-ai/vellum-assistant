/**
 * Resolves per-channel destination endpoints for notification delivery.
 *
 * - Vellum: no external endpoint needed — delivery goes through the IPC
 *   broadcast mechanism to connected desktop/mobile clients.
 * - Binding-based channels (telegram, sms): require a chat/delivery ID
 *   sourced from the guardian binding for the assistant.
 */

import { isNotificationDeliverable } from '../channels/config.js';
import { getActiveBinding } from '../memory/channel-guardian-store.js';
import type { ChannelDestination, NotificationChannel } from './types.js';

/**
 * Resolve destination information for each requested channel.
 *
 * Returns a map keyed by channel name. Channels that cannot be resolved
 * (e.g. no Telegram binding configured) are omitted from the result.
 * Channels that are not deliverable per the policy registry are skipped.
 */
export function resolveDestinations(
  assistantId: string,
  channels: NotificationChannel[],
): Map<NotificationChannel, ChannelDestination> {
  const result = new Map<NotificationChannel, ChannelDestination>();

  for (const channel of channels) {
    if (!isNotificationDeliverable(channel)) continue;

    switch (channel) {
      case 'vellum': {
        // Vellum delivery is local IPC — no external endpoint required.
        result.set('vellum', { channel: 'vellum' });
        break;
      }
      case 'telegram':
      case 'sms': {
        const binding = getActiveBinding(assistantId, channel);
        if (binding) {
          result.set(channel, {
            channel,
            endpoint: binding.guardianDeliveryChatId,
            metadata: {
              externalUserId: binding.guardianExternalUserId,
            },
          });
        }
        // If no binding exists, skip — the channel is not configured.
        break;
      }
      default: {
        // Channel with no resolver — skip silently.
        break;
      }
    }
  }

  return result;
}
