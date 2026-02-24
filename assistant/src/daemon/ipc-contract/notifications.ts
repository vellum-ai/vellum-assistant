// Notification settings IPC messages.

// === Client → Server ===

export interface NotificationSettingsGet {
  type: 'notification_settings_get';
}

export interface NotificationSettingsSet {
  type: 'notification_settings_set';
  notificationType: string;
  channel: string;
  enabled: boolean;
}

export interface NotificationSettingsSetBulk {
  type: 'notification_settings_set_bulk';
  preferences: Array<{
    notificationType: string;
    channel: string;
    enabled: boolean;
  }>;
}

export interface NotificationSettingsListTypes {
  type: 'notification_settings_list_types';
}

// === Server → Client ===

export interface NotificationSettingsResponse {
  type: 'notification_settings_response';
  success: boolean;
  error?: string;
  /** All supported notification types with their delivery class. */
  supportedTypes?: Array<{
    type: string;
    deliveryClass: string;
  }>;
  /** All supported channels. */
  channels?: string[];
  /** Current preference matrix: which (type, channel) pairs are enabled. */
  preferences?: Array<{
    notificationType: string;
    channel: string;
    enabled: boolean;
  }>;
  /** Per-channel readiness status (whether the channel is configured and operational). */
  channelReadiness?: Array<{
    channel: string;
    ready: boolean;
  }>;
}
