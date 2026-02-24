// Parental control IPC types.
//
// The parental control system lets a parent or guardian lock the assistant
// behind a 6-digit PIN and configure per-topic content restrictions and
// per-category tool blocks. All mutating operations require the PIN when
// one has been set.

// === Shared data types ===

/**
 * Topics that can be individually blocked.
 * All unlisted topics are allowed.
 */
export type ParentalContentTopic =
  | 'violence'
  | 'adult_content'
  | 'political'
  | 'gambling'
  | 'drugs';

/**
 * Broad tool categories that can be disabled for age-appropriate use.
 * When a category is blocked, individual tool invocations within that
 * category are rejected before the permission pipeline runs.
 */
export type ParentalToolCategory =
  | 'computer_use'
  | 'network'
  | 'shell'
  | 'file_write';

// === Client → Server ===

/** Retrieve the current parental control settings and PIN status. */
export interface ParentalControlGetRequest {
  type: 'parental_control_get';
}

/** Verify a PIN attempt without changing any state. Useful to gate an unlock-settings flow before showing the full panel. */
export interface ParentalControlVerifyPinRequest {
  type: 'parental_control_verify_pin';
  pin: string;
}

/** Set, change, or clear the parental control PIN. To set for the first time provide only new_pin. To change provide current_pin and new_pin. To clear provide current_pin and set clear:true. */
export interface ParentalControlSetPinRequest {
  type: 'parental_control_set_pin';
  current_pin?: string;
  new_pin?: string;
  clear?: boolean;
}

/** Update parental control settings. Requires the PIN when parental mode is already enabled. */
export interface ParentalControlUpdateRequest {
  type: 'parental_control_update';
  /** Current PIN — required when parental mode is already enabled. */
  pin?: string;
  /** Enable or disable parental control mode. */
  enabled?: boolean;
  /** Full replacement list of blocked content topics. */
  content_restrictions?: ParentalContentTopic[];
  /** Full replacement list of blocked tool categories. */
  blocked_tool_categories?: ParentalToolCategory[];
}

// === Server → Client ===

export interface ParentalControlGetResponse {
  type: 'parental_control_get_response';
  enabled: boolean;
  has_pin: boolean;
  content_restrictions: ParentalContentTopic[];
  blocked_tool_categories: ParentalToolCategory[];
}

export interface ParentalControlVerifyPinResponse {
  type: 'parental_control_verify_pin_response';
  verified: boolean;
}

export interface ParentalControlSetPinResponse {
  type: 'parental_control_set_pin_response';
  success: boolean;
  error?: string;
}

export interface ParentalControlUpdateResponse {
  type: 'parental_control_update_response';
  success: boolean;
  error?: string;
  enabled: boolean;
  has_pin: boolean;
  content_restrictions: ParentalContentTopic[];
  blocked_tool_categories: ParentalToolCategory[];
}
