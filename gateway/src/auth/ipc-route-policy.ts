/**
 * Policy enforcement for IPC-proxied routes.
 *
 * The gateway owns scope and principal-type enforcement for requests
 * routed through the IPC proxy. Each protected route is registered by
 * operationId — the same identifier the route schema cache uses for
 * matching. Unregistered operationIds have no policy (open access once
 * past JWT validation).
 *
 * This registry mirrors the daemon's route-policy.ts but is keyed by
 * operationId rather than endpoint, and lives gateway-side so policy
 * enforcement doesn't depend on the daemon.
 */

import type { PrincipalType, Scope } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IpcRoutePolicy {
  requiredScopes: readonly Scope[];
  allowedPrincipalTypes: readonly PrincipalType[];
}

// ---------------------------------------------------------------------------
// Default principal types — most routes allow all four.
// ---------------------------------------------------------------------------

const ALL_PRINCIPALS: readonly PrincipalType[] = [
  "actor",
  "svc_gateway",
  "svc_daemon",
  "local",
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type PolicyEntry =
  | [operationId: string, scopes: Scope[]]
  | [operationId: string, scopes: Scope[], principals: PrincipalType[]];

/**
 * Compact policy table. Two-element tuples use ALL_PRINCIPALS;
 * three-element tuples specify restricted principal types.
 */
const POLICY_TABLE: PolicyEntry[] = [
  // Admin / internal
  ["admin_rollbackmigrations_post", ["internal.write"], ["svc_gateway"]],
  ["internal_mcp_auth_start", ["internal.write"], ["svc_gateway"]],
  ["internal_mcp_auth_status", ["internal.write"], ["svc_gateway"]],
  ["internal_mcp_reload", ["internal.write"], ["svc_gateway"]],
  ["internal_oauth_connect_start", ["internal.write"], ["svc_gateway"]],
  ["internal_oauth_connect_status", ["internal.write"], ["svc_gateway"]],

  // Calls
  ["calls_answer", ["calls.write"]],
  ["calls_cancel", ["calls.write"]],
  ["calls_get", ["calls.read"]],
  ["calls_instruction", ["calls.write"]],
  ["calls_start", ["calls.write"]],

  // Channel readiness
  ["channels_readiness_get", ["settings.read"]],
  ["channels_readiness_refresh_post", ["settings.write"]],

  // Config / platform
  ["config_platform_get", ["settings.read"]],
  ["config_platform_put", ["settings.write"]],

  // Diagnostics
  ["diagnostics_envvars_get", ["settings.read"]],

  // Dictation / STT / TTS
  ["dictation_post", ["chat.write"]],
  ["messages_tts", ["chat.read"]],
  ["stt_providers", ["settings.read"]],
  ["stt_transcribe", ["chat.write"]],
  ["tts_synthesize", ["chat.read"]],

  // Documents
  ["getDocument", ["settings.read"]],
  ["listDocuments", ["settings.read"]],
  ["saveDocument", ["settings.write"]],

  // Filing / heartbeat
  ["getFilingConfig", ["settings.read"]],
  ["getHeartbeatConfig", ["settings.read"]],
  ["runFilingNow", ["settings.write"]],
  ["runHeartbeatNow", ["settings.write"]],
  ["updateHeartbeatConfig", ["settings.write"]],

  // Integrations / ingress
  ["integrations_ingress_config_get", ["settings.read"]],
  ["integrations_ingress_config_put", ["settings.write"]],
  ["integrations_oauth_start_post", ["settings.write"]],

  // Integrations / Slack channel
  ["integrations_slack_channel_config_get", ["settings.read"]],
  ["integrations_slack_channel_config_post", ["settings.write"]],
  ["integrations_slack_channel_config_delete", ["settings.write"]],

  // Integrations / Telegram
  ["integrations_telegram_config_get", ["settings.read"]],
  ["integrations_telegram_config_post", ["settings.write"]],
  ["integrations_telegram_config_delete", ["settings.write"]],
  ["integrations_telegram_commands_post", ["settings.write"]],
  ["integrations_telegram_setup_post", ["settings.write"]],

  // Integrations / Twilio
  ["integrations_twilio_config_get", ["settings.read"]],
  ["integrations_twilio_credentials_post", ["settings.write"]],
  ["integrations_twilio_credentials_delete", ["settings.write"]],
  ["integrations_twilio_numbers_get", ["settings.read"]],
  ["integrations_twilio_numbers_provision_post", ["settings.write"]],
  ["integrations_twilio_numbers_assign_post", ["settings.write"]],
  ["integrations_twilio_numbers_release_post", ["settings.write"]],

  // Integrations / Vercel
  ["integrations_vercel_config_get", ["settings.read"]],
  ["integrations_vercel_config_post", ["settings.write"]],
  ["integrations_vercel_config_delete", ["settings.write"]],

  // Slack share
  ["slack_channels_get", ["settings.read"]],
  ["slack_share_post", ["settings.write"]],

  // Memory items
  ["createMemoryItem", ["settings.write"]],
  ["deleteMemoryItem", ["settings.write"]],
  ["getMemoryItem", ["settings.read"]],
  ["listMemoryItems", ["settings.read"]],
  ["updateMemoryItem", ["settings.write"]],

  // Notification intent
  ["notificationintentresult_post", ["settings.write"]],

  // OAuth
  ["oauth_apps_connect_post", ["settings.write"]],
  ["oauth_apps_connections_get", ["settings.read"]],
  ["oauth_apps_delete", ["settings.write"]],
  ["oauth_apps_get", ["settings.read"]],
  ["oauth_apps_post", ["settings.write"]],
  ["oauth_connections_delete", ["settings.write"]],
  ["oauth_providers_by_providerKey_get", ["settings.read"]],
  ["oauth_providers_get", ["settings.read"]],
  ["oauth_start_post", ["settings.write"]],

  // Profiler (gateway-only)
  ["profiler_runs_by_runId_delete", ["internal.write"], ["svc_gateway"]],
  ["profiler_runs_by_runId_export_post", ["internal.write"], ["svc_gateway"]],
  ["profiler_runs_by_runId_get", ["internal.write"], ["svc_gateway"]],
  ["profiler_runs_get", ["internal.write"], ["svc_gateway"]],

  // Recordings
  ["recordings_pause", ["settings.write"]],
  ["recordings_resume", ["settings.write"]],
  ["recordings_start", ["settings.write"]],
  ["recordings_status_get", ["settings.read"]],
  ["recordings_status_post", ["settings.write"]],
  ["recordings_stop", ["settings.write"]],

  // Settings
  ["settings_avatar_generate_post", ["settings.write"]],
  ["settings_client_put", ["settings.write"]],
  ["settings_voice_put", ["settings.write"]],

  // Skills
  ["checkSkillUpdates", ["settings.write"]],
  ["configureSkill", ["settings.write"]],
  ["createSkill", ["settings.write"]],
  ["deleteSkill", ["settings.write"]],
  ["disableSkill", ["settings.write"]],
  ["draftSkill", ["settings.write"]],
  ["enableSkill", ["settings.write"]],
  ["getSkill", ["settings.read"]],
  ["getSkillFileContent", ["settings.read"]],
  ["getSkillFiles", ["settings.read"]],
  ["inspectSkill", ["settings.read"]],
  ["installSkill", ["settings.write"]],
  ["listSkills", ["settings.read"]],
  ["searchSkills", ["settings.read"]],
  ["updateSkill", ["settings.write"]],

  // Tools
  ["tools_get", ["settings.read"]],
  ["tools_simulate_permission_post", ["settings.read"]],

  // Workspace files
  ["workspacefiles_get", ["settings.read"]],
  ["workspacefiles_read_get", ["settings.read"]],
];

// ---------------------------------------------------------------------------
// Build the lookup map
// ---------------------------------------------------------------------------

const policyMap = new Map<string, IpcRoutePolicy>();

for (const entry of POLICY_TABLE) {
  const [operationId, scopes, principals] = entry;
  policyMap.set(operationId, {
    requiredScopes: scopes,
    allowedPrincipalTypes: principals ?? ALL_PRINCIPALS,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up the IPC route policy for an operationId.
 * Returns undefined for unregistered (unprotected) operations.
 */
export function getIpcRoutePolicy(
  operationId: string,
): IpcRoutePolicy | undefined {
  return policyMap.get(operationId);
}
