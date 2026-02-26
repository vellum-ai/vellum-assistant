/**
 * Resolves per-channel destination endpoints for notification delivery.
 *
 * - Vellum: no external endpoint needed — delivery goes through the IPC
 *   broadcast mechanism to connected desktop/mobile clients.
 * - Binding-based channels (telegram, sms): require a chat/delivery ID
 *   sourced from the guardian binding for the assistant.
 */

import { isNotificationDeliverable } from '../channels/config.js';
import type { ChannelId } from '../channels/types.js';
import { getActiveBinding } from '../memory/channel-guardian-store.js';
import type { ChannelDestination, NotificationChannel } from './types.js';

/**
 * Resolve destination information for each requested channel.
 *
 * Accepts the broad `ChannelId` union so that callers can pass any channel;
 * the function skips non-deliverable channels via `isNotificationDeliverable`.
 * Returns a map keyed by `NotificationChannel`. Channels that cannot be
 * resolved (e.g. no Telegram binding configured) are omitted from the result.
 */
export function resolveDestinations(
  assistantId: string,
  channels: readonly (ChannelId | NotificationChannel)[],
): Map<NotificationChannel, ChannelDestination> {
  const result = new Map<NotificationChannel, ChannelDestination>();

  for (const channel of channels) {
    if (!isNotificationDeliverable(channel)) continue;

    // After the deliverability check, `channel` is guaranteed to be a
    // NotificationChannel — TypeScript cannot infer this from the runtime
    // guard, so we narrow with a switch over known deliverable values.
    switch (channel as NotificationChannel) {
      case 'vellum': {
        // Vellum delivery is local IPC — no external endpoint required.
        result.set('vellum', { channel: 'vellum' });
        break;
      }
      case 'telegram':
      case 'sms': {
        const binding = getActiveBinding(assistantId, channel);
        if (binding) {
          result.set(channel as NotificationChannel, {
            channel: channel as NotificationChannel,
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
        // Future deliverable channels without a resolver — skip silently.
        break;
      }
    }
  }

  return result;
}
