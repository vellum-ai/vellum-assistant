// Client settings: daemon-pushed configuration updates to connected clients.

// === Client → Server ===

/** Request from a session or IPC client to change the voice activation key. */
export interface VoiceConfigUpdateRequest {
  type: 'voice_config_update';
  /** The desired activation key (enum value or natural-language name). */
  activationKey: string;
}

// === Server → Client ===

/** Sent by the daemon to update a client-side setting (e.g. activation key). */
export interface ClientSettingsUpdate {
  type: 'client_settings_update';
  /** The setting key to update (e.g. "activationKey"). */
  key: string;
  /** The new value for the setting. */
  value: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SettingsClientMessages = VoiceConfigUpdateRequest;
export type _SettingsServerMessages = ClientSettingsUpdate;
