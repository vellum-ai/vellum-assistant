/**
 * Resolves per-channel destination endpoints for notification delivery.
 *
 * Uses a contacts-first approach: reads guardian delivery info from the
 * contacts table, falling back to the legacy channel-guardian bindings
 * when contacts have not yet been synced.
 *
 * - Vellum: no external endpoint needed — delivery goes through the IPC
 *   broadcast mechanism to connected desktop/mobile clients. The
 *   guardianPrincipalId is included in metadata so downstream adapters
 *   can scope guardian-sensitive notifications to bound guardian devices.
 * - Binding-based channels (telegram, sms): require a chat/delivery ID
 *   sourced from the guardian contact's channel record (or legacy binding).
 */

import { isNotificationDeliverable } from '../channels/config.js';
import type { ChannelId } from '../channels/types.js';
import { findGuardianForChannel } from '../contacts/contact-store.js';
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
        // Include the guardianPrincipalId so the adapter can annotate
        // guardian-sensitive notifications for scoped delivery.
        const guardianResult = findGuardianForChannel('vellum');
        const metadata: Record<string, unknown> = {};
        if (guardianResult) {
          metadata.guardianPrincipalId = guardianResult.contact.principalId;
        } else {
          // Legacy fallback: contacts not yet synced
          const vellumBinding = getActiveBinding(assistantId, 'vellum');
          if (vellumBinding) {
            metadata.guardianPrincipalId = vellumBinding.guardianExternalUserId;
          }
        }
        result.set('vellum', {
          channel: 'vellum',
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
        break;
      }
      case 'telegram':
      case 'sms': {
        const guardianResult = findGuardianForChannel(channel);
        if (guardianResult) {
          result.set(channel as NotificationChannel, {
            channel: channel as NotificationChannel,
            endpoint: guardianResult.channel.externalChatId,
            metadata: {
              externalUserId: guardianResult.channel.externalUserId,
            },
          });
        } else {
          // Legacy fallback: contacts not yet synced
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
        }
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
