// Client settings: daemon-pushed configuration updates to connected clients.

// === Client → Server ===

/** Request from a conversation or client to change the voice activation key. */
export interface VoiceConfigUpdateRequest {
  type: "voice_config_update";
  /** The desired activation key (enum value or natural-language name). */
  activationKey: string;
}

/** Request from the client to generate a custom avatar via Gemini. */
export interface GenerateAvatarRequest {
  type: "generate_avatar";
  /** Text description of the desired avatar appearance. */
  description: string;
}

// === Server → Client ===

/** Sent by the daemon to update a client-side setting (e.g. activation key). */
export interface ClientSettingsUpdate {
  type: "client_settings_update";
  /** The setting key to update (e.g. "activationKey"). */
  key: string;
  /** The new value for the setting. */
  value: string;
}

/** Sent by the daemon after the avatar image has been regenerated and saved to disk. */
export interface AvatarUpdated {
  type: "avatar_updated";
  /** Absolute path to the updated avatar image file. */
  avatarPath: string;
}

/** Sent by the daemon when workspace config.json changes on disk. */
export interface ConfigChanged {
  type: "config_changed";
}

/** Sent by the daemon when sounds config or sound files change on disk. */
export interface SoundsConfigUpdated {
  type: "sounds_config_updated";
}

/** Response to a generate_avatar request indicating success or failure. */
export interface GenerateAvatarResponse {
  type: "generate_avatar_response";
  /** Whether the avatar was generated successfully. */
  success: boolean;
  /** Error message when success is false. */
  error?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SettingsClientMessages =
  | VoiceConfigUpdateRequest
  | GenerateAvatarRequest;
export type _SettingsServerMessages =
  | ClientSettingsUpdate
  | AvatarUpdated
  | ConfigChanged
  | SoundsConfigUpdated
  | GenerateAvatarResponse;
