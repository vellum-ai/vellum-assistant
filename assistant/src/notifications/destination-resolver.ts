/**
 * Resolves per-channel destination endpoints for notification delivery.
 *
 * - macOS: no external endpoint needed — delivery goes through the IPC
 *   broadcast mechanism to connected desktop clients.
 * - Telegram: requires a chat ID sourced from the guardian binding for the
 *   assistant.
 */

import { getActiveBinding } from '../memory/channel-guardian-store.js';
import type { NotificationChannel, ChannelDestination } from './types.js';

/**
 * Resolve destination information for each requested channel.
 *
 * Returns a map keyed by channel name. Channels that cannot be resolved
 * (e.g. no Telegram binding configured) are omitted from the result.
 */
export function resolveDestinations(
  assistantId: string,
  channels: NotificationChannel[],
): Map<NotificationChannel, ChannelDestination> {
  const result = new Map<NotificationChannel, ChannelDestination>();

  for (const channel of channels) {
    switch (channel) {
      case 'macos': {
        // macOS delivery is local IPC — no external endpoint required.
        result.set('macos', { channel: 'macos' });
        break;
      }
      case 'telegram': {
        const binding = getActiveBinding(assistantId, 'telegram');
        if (binding) {
          result.set('telegram', {
            channel: 'telegram',
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
        // Unknown channel — skip silently.
        break;
      }
    }
  }

  return result;
}
