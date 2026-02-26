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
  activeProfile?: 'parental' | 'child';
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

/** Get the currently active profile. */
export interface ParentalControlProfileGetRequest {
  type: 'parental_control_profile_get';
}

/** Switch the active profile. Switching TO "parental" requires the PIN when one has been set. */
export interface ParentalControlProfileSwitchRequest {
  type: 'parental_control_profile_switch';
  targetProfile: 'parental' | 'child';
  /** Required when switching TO "parental" and a PIN has been set. */
  pin?: string;
}

export interface ParentalControlProfileGetResponse {
  type: 'parental_control_profile_get_response';
  activeProfile: 'parental' | 'child';
}

export interface ParentalControlProfileSwitchResponse {
  type: 'parental_control_profile_switch_response';
  success: boolean;
  activeProfile: 'parental' | 'child';
  error?: string;
}

// === App / Widget Allowlist (Client → Server) ===

/** Retrieve the current app and widget allowlists. */
export interface ParentalControlAllowlistGetRequest {
  type: 'parental_control_allowlist_get';
}

/** Update the app and/or widget allowlist. PIN required when parental controls are enabled. */
export interface ParentalControlAllowlistUpdateRequest {
  type: 'parental_control_allowlist_update';
  /** Current PIN — required when parental mode is already enabled. */
  pin?: string;
  /** Full replacement list of allowed app names. */
  allowedApps?: string[];
  /** Full replacement list of allowed widget names. */
  allowedWidgets?: string[];
}

// === App / Widget Allowlist (Server → Client) ===

export interface ParentalControlAllowlistGetResponse {
  type: 'parental_control_allowlist_get_response';
  allowedApps: string[];
  allowedWidgets: string[];
}

export interface ParentalControlAllowlistUpdateResponse {
  type: 'parental_control_allowlist_update_response';
  success: boolean;
  allowedApps: string[];
  allowedWidgets: string[];
  error?: string;
}

// Create approval request (called from child profile context)
export interface ParentalControlApprovalCreateRequest {
  type: 'parental_control_approval_create'
  toolName: string
  reason: string
}
export interface ParentalControlApprovalCreateResponse {
  type: 'parental_control_approval_create_response'
  success: boolean
  requestId: string
  error?: string
}

// List approval requests (parent only - requires PIN or unlocked state)
export interface ParentalControlApprovalListRequest {
  type: 'parental_control_approval_list'
  pin?: string
}
export interface ParentalControlApprovalListResponse {
  type: 'parental_control_approval_list_response'
  requests: Array<{
    id: string
    toolName: string
    reason: string
    status: string
    createdAt: string
    resolvedAt?: string
  }>
  error?: string
}

// Respond to approval request (parent only - requires PIN)
export interface ParentalControlApprovalRespondRequest {
  type: 'parental_control_approval_respond'
  requestId: string
  decision: 'approve_always' | 'approve_once' | 'reject'
  pin?: string
}
export interface ParentalControlApprovalRespondResponse {
  type: 'parental_control_approval_respond_response'
  success: boolean
  error?: string
}

// === Activity Log ===

/** A single recorded child-profile action. */
export interface ParentalActivityLogEntryData {
  id: string;
  timestamp: string;
  profile: 'child';
  actionType: 'tool_call' | 'request' | 'approval_request';
  description: string;
  metadata?: Record<string, unknown>;
}

/** One-way: mac → daemon. Append one entry to the activity log. */
export interface ParentalActivityLogAppendRequest {
  type: 'parental_activity_log_append';
  actionType: 'tool_call' | 'request' | 'approval_request';
  description: string;
  metadata?: Record<string, unknown>;
}

/** mac → daemon: request the full list of activity log entries. */
export interface ParentalActivityLogListRequest {
  type: 'parental_activity_log_list';
}

/** daemon → mac: response carrying all activity log entries. */
export interface ParentalActivityLogListResponse {
  type: 'parental_activity_log_list_response';
  entries: ParentalActivityLogEntryData[];
}

/** mac → daemon: clear all activity log entries. */
export interface ParentalActivityLogClearRequest {
  type: 'parental_activity_log_clear';
}

/** daemon → mac: confirmation that the log was cleared. */
export interface ParentalActivityLogClearResponse {
  type: 'parental_activity_log_clear_response';
  success: boolean;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _ParentalControlClientMessages =
  | ParentalControlGetRequest
  | ParentalControlVerifyPinRequest
  | ParentalControlSetPinRequest
  | ParentalControlUpdateRequest
  | ParentalControlProfileGetRequest
  | ParentalControlProfileSwitchRequest
  | ParentalControlAllowlistGetRequest
  | ParentalControlAllowlistUpdateRequest
  | ParentalControlApprovalCreateRequest
  | ParentalControlApprovalListRequest
  | ParentalControlApprovalRespondRequest
  | ParentalActivityLogAppendRequest
  | ParentalActivityLogListRequest
  | ParentalActivityLogClearRequest;

export type _ParentalControlServerMessages =
  | ParentalControlGetResponse
  | ParentalControlVerifyPinResponse
  | ParentalControlSetPinResponse
  | ParentalControlUpdateResponse
  | ParentalControlProfileGetResponse
  | ParentalControlProfileSwitchResponse
  | ParentalControlAllowlistGetResponse
  | ParentalControlAllowlistUpdateResponse
  | ParentalControlApprovalCreateResponse
  | ParentalControlApprovalListResponse
  | ParentalControlApprovalRespondResponse
  | ParentalActivityLogListResponse
  | ParentalActivityLogClearResponse;
