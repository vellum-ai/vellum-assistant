import * as net from 'node:net';
import type {
  NotificationSettingsGet,
  NotificationSettingsSet,
  NotificationSettingsSetBulk,
  NotificationSettingsListTypes,
} from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';
import {
  getPreferences,
  setPreference,
  setBulkPreferences,
} from '../../notifications/preferences-store.js';
import {
  NotificationType,
  NotificationDeliveryClass,
  NOTIFICATION_DELIVERY_CLASS_MAP,
} from '../../notifications/types.js';
import type { NotificationChannel } from '../../notifications/types.js';

const SUPPORTED_CHANNELS: NotificationChannel[] = ['macos', 'telegram'];

// The assistant ID used for single-user (self-hosted) mode.
const SELF_ASSISTANT_ID = 'self';

function buildSettingsResponse(ctx: HandlerContext) {
  const prefs = getPreferences(SELF_ASSISTANT_ID);

  const supportedTypes = Object.values(NotificationType).map((t) => ({
    type: t,
    deliveryClass: NOTIFICATION_DELIVERY_CLASS_MAP[t],
  }));

  // Channel readiness: for now, macos is always ready. Telegram readiness
  // would require checking config; start with a simple placeholder.
  const channelReadiness = SUPPORTED_CHANNELS.map((ch) => ({
    channel: ch,
    ready: ch === 'macos', // telegram readiness will be wired in a follow-up
  }));

  return {
    type: 'notification_settings_response' as const,
    success: true,
    supportedTypes,
    channels: [...SUPPORTED_CHANNELS],
    preferences: prefs.map((p) => ({
      notificationType: p.notificationType,
      channel: p.channel,
      enabled: p.enabled,
    })),
    channelReadiness,
  };
}

function isValidNotificationType(t: string): t is NotificationType {
  return Object.values(NotificationType).includes(t as NotificationType);
}

function isValidChannel(ch: string): ch is NotificationChannel {
  return SUPPORTED_CHANNELS.includes(ch as NotificationChannel);
}

function handleNotificationSettingsGet(
  _msg: NotificationSettingsGet,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    ctx.send(socket, buildSettingsResponse(ctx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'notification_settings_get handler error');
    ctx.send(socket, { type: 'notification_settings_response', success: false, error: message });
  }
}

function handleNotificationSettingsSet(
  msg: NotificationSettingsSet,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    if (!isValidNotificationType(msg.notificationType)) {
      ctx.send(socket, { type: 'notification_settings_response', success: false, error: `Unknown notification type: ${msg.notificationType}` });
      return;
    }
    if (!isValidChannel(msg.channel)) {
      ctx.send(socket, { type: 'notification_settings_response', success: false, error: `Unknown channel: ${msg.channel}` });
      return;
    }

    setPreference(SELF_ASSISTANT_ID, msg.notificationType, msg.channel, msg.enabled);
    log.info({ notificationType: msg.notificationType, channel: msg.channel, enabled: msg.enabled }, 'Notification preference updated');
    ctx.send(socket, buildSettingsResponse(ctx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'notification_settings_set handler error');
    ctx.send(socket, { type: 'notification_settings_response', success: false, error: message });
  }
}

function handleNotificationSettingsSetBulk(
  msg: NotificationSettingsSetBulk,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    if (!Array.isArray(msg.preferences) || msg.preferences.length === 0) {
      ctx.send(socket, { type: 'notification_settings_response', success: false, error: 'preferences array is required and must not be empty' });
      return;
    }

    // Validate all entries before applying any
    for (const pref of msg.preferences) {
      if (!isValidNotificationType(pref.notificationType)) {
        ctx.send(socket, { type: 'notification_settings_response', success: false, error: `Unknown notification type: ${pref.notificationType}` });
        return;
      }
      if (!isValidChannel(pref.channel)) {
        ctx.send(socket, { type: 'notification_settings_response', success: false, error: `Unknown channel: ${pref.channel}` });
        return;
      }
    }

    setBulkPreferences(
      SELF_ASSISTANT_ID,
      msg.preferences.map((p) => ({
        notificationType: p.notificationType as NotificationType,
        channel: p.channel as NotificationChannel,
        enabled: p.enabled,
      })),
    );

    log.info({ count: msg.preferences.length }, 'Notification preferences bulk updated');
    ctx.send(socket, buildSettingsResponse(ctx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'notification_settings_set_bulk handler error');
    ctx.send(socket, { type: 'notification_settings_response', success: false, error: message });
  }
}

function handleNotificationSettingsListTypes(
  _msg: NotificationSettingsListTypes,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    ctx.send(socket, buildSettingsResponse(ctx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'notification_settings_list_types handler error');
    ctx.send(socket, { type: 'notification_settings_response', success: false, error: message });
  }
}

export const notificationSettingsHandlers = defineHandlers({
  notification_settings_get: handleNotificationSettingsGet,
  notification_settings_set: handleNotificationSettingsSet,
  notification_settings_set_bulk: handleNotificationSettingsSetBulk,
  notification_settings_list_types: handleNotificationSettingsListTypes,
});
