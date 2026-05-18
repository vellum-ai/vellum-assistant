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
  //
  // Every operationId whose daemon-side route policy is gateway-only
  // (`allowedPrincipalTypes: ["svc_gateway"]` in
  // `assistant/src/runtime/auth/route-policy.ts`) MUST have a matching
  // entry here. The gateway IPC proxy default-allows operationIds with
  // no policy entry, so an authenticated edge JWT could otherwise reach
  // them by setting `X-Vellum-Proxy-Server: ipc`, bypassing the daemon
  // HTTP router entirely.
  //
  // The `ipc-route-policy-coverage.test.ts` lint enforces this invariant
  // by walking the daemon route source files at test time.
  ["admin_rollbackmigrations_post", ["internal.write"], ["svc_gateway"]],
  ["channel_inbound", ["ingress.write"], ["svc_gateway"]],
  ["emit_event", ["internal.write"], ["svc_gateway"]],
  ["internal_mcp_add", ["internal.write"], ["svc_gateway"]],
  ["internal_mcp_auth_start", ["internal.write"], ["svc_gateway"]],
  ["internal_mcp_auth_status", ["internal.write"], ["svc_gateway"]],
  ["internal_mcp_list", ["internal.write"], ["svc_gateway"]],
  ["internal_mcp_reload", ["internal.write"], ["svc_gateway"]],
  ["internal_mcp_remove", ["internal.write"], ["svc_gateway"]],
  ["internal_oauth_callback", ["internal.write"], ["svc_gateway"]],
  ["internal_oauth_connect_start", ["internal.write"], ["svc_gateway"]],
  ["internal_oauth_connect_status", ["internal.write"], ["svc_gateway"]],
  ["internal_twilio_connect_action", ["internal.write"], ["svc_gateway"]],
  ["internal_twilio_status", ["internal.write"], ["svc_gateway"]],
  ["internal_twilio_voice_webhook", ["internal.write"], ["svc_gateway"]],
  ["upgrade_broadcast", ["internal.write"], ["svc_gateway"]],
  ["workspace_commit", ["internal.write"], ["svc_gateway"]],

  // Backups (incremental + destinations)
  ["backup_destinations_add", ["settings.write"]],
  ["backup_destinations_list", ["settings.read"]],
  ["backup_destinations_remove", ["settings.write"]],
  ["backup_destinations_set_encrypt", ["settings.write"]],
  ["backup_disable", ["settings.write"]],
  ["backup_enable", ["settings.write"]],
  ["backup_status", ["settings.read"]],
  ["backups_create", ["settings.write"]],
  ["backups_list", ["settings.read"]],
  ["backups_restore", ["settings.write"]],
  ["backups_verify", ["settings.read"]],

  // Calls
  ["calls_answer", ["calls.write"]],
  ["calls_cancel", ["calls.write"]],
  ["calls_get", ["calls.read"]],
  ["calls_instruction", ["calls.write"]],
  ["calls_start", ["calls.write"]],

  // Channel readiness
  ["channels_readiness_get", ["settings.read"]],
  ["channels_readiness_refresh_post", ["settings.write"]],

  // Config
  ["config_allowlist_validate", ["settings.read"]],
  ["config_platform_get", ["settings.read"]],
  ["config_platform_put", ["settings.write"]],
  ["config_schema_get", ["settings.read"]],
  ["config_set", ["settings.write"]],

  // Conversation CLI
  //
  // The daemon HTTP policy elevates these from chat.* to settings.*
  // (see `assistant/src/runtime/auth/route-policy.ts` —
  // `conversations/cli/clear` is locked to `settings.write` "mirroring the
  // `conversations/clear-all` and `conversations/wipe` gates" because
  // clear-cli wipes every conversation + message + vector collection).
  // The IPC entries mirror that elevation — anything weaker on IPC would
  // mean a future scope profile granting `chat.write` without
  // `settings.write` lets the destructive clear-cli bypass the daemon's
  // explicit elevation.
  ["conversation_create_cli", ["settings.write"]],
  ["conversation_export_cli", ["settings.read"]],
  ["conversation_list_cli", ["settings.read"]],
  ["conversations_clear_cli", ["settings.write"]],

  // Credentials
  //
  // Every credential route declares `policyKey: "secrets"` and uses POST
  // (except `credentials_status` which is GET). The daemon HTTP router
  // resolves them as:
  //   - POST → "secrets:POST" not registered → falls back to "secrets"
  //     → settings.write
  //   - GET  → "secrets:GET" → settings.read
  // So inspect/list/reveal/set/delete all require settings.write on the
  // HTTP path. Mapping the read-shaped ones (list/inspect/reveal) to
  // settings.read on IPC would make IPC strictly more permissive than
  // HTTP — exactly the drift class the gateway IPC policy table exists
  // to prevent.
  //
  // ATL-510 separately tracks the `credentials_reveal` plaintext-leak
  // (the handler returns the plaintext value); that's a route-level fix,
  // not a policy-table change.
  ["credentials_delete", ["settings.write"]],
  ["credentials_inspect", ["settings.write"]],
  ["credentials_list", ["settings.write"]],
  ["credentials_reveal", ["settings.write"]],
  ["credentials_set", ["settings.write"]],
  ["credentials_status", ["settings.read"]],

  // Debug
  //
  // VELLUM_DEBUG=1 gates the handler at the daemon side — when debug
  // mode is off (the default), the handler returns an error before
  // executing any command. The IPC scope here is the defense-in-depth
  // layer: it requires settings.write on the edge JWT in addition to
  // the daemon-side VELLUM_DEBUG gate.
  ["debug_bash", ["settings.write"]],

  // Diagnostics
  ["diagnostics_envvars_get", ["settings.read"]],

  // Dictation / STT / TTS
  ["dictation_post", ["chat.write"]],
  ["messages_tts", ["chat.read"]],
  ["stt_providers", ["settings.read"]],
  ["stt_transcribe", ["chat.write"]],
  // `stt_transcribe_file` reads/transcodes an arbitrary host filesystem
  // path. The daemon HTTP policy locks it to ["local"] because, in the
  // daemon's words, "non-local callers cannot be allowed to drive it"
  // (`assistant/src/runtime/auth/route-policy.ts` — `stt/transcribe-file`
  // policy block). The IPC entry mirrors that boundary — otherwise an
  // actor JWT with chat.write can drive arbitrary host-path reads
  // through the gateway IPC proxy.
  ["stt_transcribe_file", ["chat.write"], ["local"]],
  ["tts_synthesize", ["chat.read"]],
  ["tts_synthesize_cli", ["chat.read"]],

  // Domain
  ["domain_register", ["settings.write"]],
  ["domain_status", ["settings.read"]],

  // Email
  ["email_attachment_get", ["settings.read"]],
  ["email_attachment_list", ["settings.read"]],
  ["email_download", ["settings.read"]],
  ["email_list", ["settings.read"]],
  ["email_register", ["settings.write"]],
  ["email_send", ["settings.write"]],
  ["email_status", ["settings.read"]],
  ["email_unregister", ["settings.write"]],

  // Platform
  ["platform_callback_routes_list", ["settings.read"]],
  ["platform_callback_routes_register", ["settings.write"]],
  ["platform_connect", ["settings.write"]],
  ["platform_disconnect", ["settings.write"]],
  ["platform_status", ["settings.read"]],

  // Schedules
  ["createSchedule", ["settings.write"]],

  // Sequences
  ["sequence_cancel_enrollment", ["settings.write"]],
  ["sequence_get", ["settings.read"]],
  ["sequence_guardrails_set", ["settings.write"]],
  ["sequence_guardrails_show", ["settings.read"]],
  ["sequence_list", ["settings.read"]],
  ["sequence_pause", ["settings.write"]],
  ["sequence_resume", ["settings.write"]],
  ["sequence_stats", ["settings.read"]],

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
  [
    "integrations_a2a_invite_complete_post",
    ["internal.write"],
    ["svc_gateway"],
  ],
  ["integrations_a2a_invite_redeem_post", ["internal.write"], ["svc_gateway"]],
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

  // Inference profile sessions
  ["inference_profile_close", ["chat.write"]],
  ["inference_profile_list", ["chat.read"]],
  ["inference_profile_open", ["chat.write"]],

  // Inference provider connections
  ["inference_provider_connections_create", ["settings.write"]],
  ["inference_provider_connections_delete", ["settings.write"]],
  ["inference_provider_connections_get", ["settings.read"]],
  ["inference_provider_connections_list", ["settings.read"]],
  ["inference_provider_connections_update", ["settings.write"]],

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
