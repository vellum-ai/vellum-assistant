/**
 * Shared route definitions served by BOTH the HTTP server and the IPC server.
 *
 * Routes listed here are registered in the HTTP router (via buildRouteTable)
 * and exposed as IPC methods on the AssistantIpcServer.
 *
 * Over time, routes will migrate from their HTTP-only or IPC-only homes
 * into this shared array.
 */

import { ROUTES as ACP_ROUTES } from "./acp-routes.js";
import { ROUTES as APP_MANAGEMENT_ROUTES } from "./app-management-routes.js";
import { ROUTES as APP_ROUTES } from "./app-routes.js";
import { ROUTES as APPROVAL_ROUTES } from "./approval-routes.js";
import { ROUTES as ATTACHMENT_ROUTES } from "./attachment-routes.js";
import { ROUTES as AUDIO_ROUTES } from "./audio-routes.js";
import { ROUTES as AVATAR_ROUTES } from "./avatar-routes.js";
import { ROUTES as BACKGROUND_TOOL_ROUTES } from "./background-tool-routes.js";
import { ROUTES as BACKUP_ROUTES } from "./backup-routes.js";
import { ROUTES as BRAIN_GRAPH_ROUTES } from "./brain-graph-routes.js";
import { ROUTES as BROWSER_ROUTES } from "./browser-routes.js";
import { ROUTES as BTW_ROUTES } from "./btw-routes.js";
import { ROUTES as CACHE_ROUTES } from "./cache-routes.js";
import { ROUTES as CALL_ROUTES } from "./call-routes.js";
import { ROUTES as CHANNEL_READINESS_ROUTES } from "./channel-readiness-routes.js";
import { CHANNEL_ROUTES } from "./channel-route-definitions.js";
import { ROUTES as CHANNEL_VERIFICATION_ROUTES } from "./channel-verification-routes.js";
import { ROUTES as CLIENT_ROUTES } from "./client-routes.js";
import { ROUTES as CONSOLIDATION_ROUTES } from "./consolidation-routes.js";
import { CONTACT_PROMPT_ROUTES } from "./contact-prompt-routes.js";
import { ROUTES as CONTACT_ROUTES } from "./contact-routes.js";
import { ROUTES as CONVERSATION_ANALYSIS_ROUTES } from "./conversation-analysis-routes.js";
import { ROUTES as CONVERSATION_ATTENTION_ROUTES } from "./conversation-attention-routes.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "./conversation-list-routes.js";
import { ROUTES as CONVERSATION_MANAGEMENT_ROUTES } from "./conversation-management-routes.js";
import { ROUTES as CONVERSATION_QUERY_ROUTES } from "./conversation-query-routes.js";
import { ROUTES as CONVERSATION_MESSAGE_ROUTES } from "./conversation-routes.js";
import { ROUTES as CONVERSATION_STARTER_ROUTES } from "./conversation-starter-routes.js";
import { ROUTES as CREDENTIAL_PROMPT_ROUTES } from "./credential-prompt-routes.js";
import { ROUTES as DEBUG_ROUTES } from "./debug-routes.js";
import { ROUTES as DEFER_ROUTES } from "./defer-routes.js";
import { ROUTES as DIAGNOSTICS_ROUTES } from "./diagnostics-routes.js";
import { ROUTES as DOCUMENT_ROUTES } from "./documents-routes.js";
import { ROUTES as EVENTS_ROUTES } from "./events-routes.js";
import { ROUTES as FILING_ROUTES } from "./filing-routes.js";
import { ROUTES as GLOBAL_SEARCH_ROUTES } from "./global-search-routes.js";
import { ROUTES as GROUP_ROUTES } from "./group-routes.js";
import { ROUTES as GUARDIAN_ACTION_ROUTES } from "./guardian-action-routes.js";
import { ROUTES as HEARTBEAT_ROUTES } from "./heartbeat-routes.js";
import { ROUTES as HOME_FEED_ROUTES } from "./home-feed-routes.js";
import { ROUTES as HOME_STATE_ROUTES } from "./home-state-routes.js";
import { ROUTES as HOST_APP_CONTROL_ROUTES } from "./host-app-control-routes.js";
import { ROUTES as HOST_BASH_ROUTES } from "./host-bash-routes.js";
import { ROUTES as HOST_BROWSER_ROUTES } from "./host-browser-routes.js";
import { ROUTES as HOST_CU_ROUTES } from "./host-cu-routes.js";
import { ROUTES as HOST_FILE_ROUTES } from "./host-file-routes.js";
import { ROUTES as HOST_TRANSFER_ROUTES } from "./host-transfer-routes.js";
import { ROUTES as IDENTITY_ROUTES } from "./identity-routes.js";
import { ROUTES as SLACK_CHANNEL_ROUTES } from "./integrations/slack/channel.js";
import { ROUTES as SLACK_SHARE_ROUTES } from "./integrations/slack/share.js";
import { ROUTES as TELEGRAM_ROUTES } from "./integrations/telegram.js";
import { ROUTES as TWILIO_ROUTES } from "./integrations/twilio.js";
import { ROUTES as VERCEL_ROUTES } from "./integrations/vercel.js";
import { ROUTES as INTERFACE_ROUTES } from "./interface-routes.js";
import { ROUTES as INTERNAL_OAUTH_ROUTES } from "./internal-oauth-routes.js";
import { ROUTES as INTERNAL_TWILIO_ROUTES } from "./internal-twilio-routes.js";
import { ROUTES as LLM_CALL_SITES_ROUTES } from "./llm-call-sites-routes.js";
import { ROUTES as LOG_EXPORT_ROUTES } from "./log-export-routes.js";
import { ROUTES as MEMORY_ITEM_ROUTES } from "./memory-item-routes.js";
import { ROUTES as MEMORY_V2_ROUTES } from "./memory-v2-routes.js";
import { ROUTES as MIGRATION_ROLLBACK_ROUTES } from "./migration-rollback-routes.js";
import { ROUTES as MIGRATION_ROUTES } from "./migration-routes.js";
import { ROUTES as NOTIFICATION_ROUTES } from "./notification-routes.js";
import { ROUTES as OAUTH_APPS_ROUTES } from "./oauth-apps.js";
import { ROUTES as OAUTH_PROVIDERS_ROUTES } from "./oauth-providers.js";
import { ROUTES as PLAYGROUND_ROUTES } from "./playground/index.js";
import { ROUTES as PROFILER_ROUTES } from "./profiler-routes.js";
import { ROUTES as PS_ROUTES } from "./ps-routes.js";
import { ROUTES as RECORDING_ROUTES } from "./recording-routes.js";
import { ROUTES as RENAME_CONVERSATION_ROUTES } from "./rename-conversation-routes.js";
import { ROUTES as SCHEDULE_ROUTES } from "./schedule-routes.js";
import { ROUTES as SECRET_ROUTES } from "./secret-routes.js";
import { ROUTES as SETTINGS_ROUTES } from "./settings-routes.js";
import { ROUTES as SKILL_ROUTES } from "./skills-routes.js";
import { ROUTES as STT_ROUTES } from "./stt-routes.js";
import { ROUTES as SUBAGENT_ROUTES } from "./subagents-routes.js";
import { ROUTES as SUGGEST_TRUST_RULE_ROUTES } from "./suggest-trust-rule-routes.js";
import { ROUTES as SURFACE_ACTION_ROUTES } from "./surface-action-routes.js";
import { ROUTES as SURFACE_CONTENT_ROUTES } from "./surface-content-routes.js";
import { ROUTES as TASK_ROUTES } from "./task-routes.js";
import { ROUTES as TELEMETRY_ROUTES } from "./telemetry-routes.js";
import { ROUTES as TRACE_EVENT_ROUTES } from "./trace-event-routes.js";
import { ROUTES as TRUST_RULES_ROUTES } from "./trust-rules-routes.js";
import { ROUTES as TTS_ROUTES } from "./tts-routes.js";
import type { RouteDefinition } from "./types.js";
import { ROUTES as UI_REQUEST_ROUTES } from "./ui-request-routes.js";
import { ROUTES as UPGRADE_BROADCAST_ROUTES } from "./upgrade-broadcast-routes.js";
import { ROUTES as USAGE_ROUTES } from "./usage-routes.js";
import { ROUTES as USER_ROUTES } from "./user-routes.js";
import { ROUTES as WAKE_CONVERSATION_ROUTES } from "./wake-conversation-routes.js";
import { ROUTES as WATCHER_ROUTES } from "./watcher-routes.js";
import { ROUTES as WIPE_CONVERSATION_ROUTES } from "./wipe-conversation-routes.js";
import { ROUTES as WORK_ITEM_ROUTES } from "./work-items-routes.js";
import { ROUTES as WORKSPACE_COMMIT_ROUTES } from "./workspace-commit-routes.js";
import { ROUTES as WORKSPACE_ROUTES } from "./workspace-routes.js";

export const ROUTES: RouteDefinition[] = [
  ...ATTACHMENT_ROUTES,
  ...ACP_ROUTES,
  ...APP_MANAGEMENT_ROUTES,
  ...APP_ROUTES,
  ...APPROVAL_ROUTES,
  ...AUDIO_ROUTES,
  ...AVATAR_ROUTES,
  ...BACKGROUND_TOOL_ROUTES,
  ...BACKUP_ROUTES,
  ...CACHE_ROUTES,
  ...CALL_ROUTES,
  ...CHANNEL_ROUTES,
  ...CHANNEL_VERIFICATION_ROUTES,
  ...CHANNEL_READINESS_ROUTES,
  ...BROWSER_ROUTES,
  ...BTW_ROUTES,
  ...BRAIN_GRAPH_ROUTES,
  ...CLIENT_ROUTES,
  ...CONTACT_PROMPT_ROUTES,
  ...CONTACT_ROUTES,
  ...CONVERSATION_ANALYSIS_ROUTES,
  ...CONVERSATION_ATTENTION_ROUTES,
  ...CONVERSATION_LIST_ROUTES,
  ...CONVERSATION_MANAGEMENT_ROUTES,
  ...CONVERSATION_MESSAGE_ROUTES,
  ...CONSOLIDATION_ROUTES,
  ...CREDENTIAL_PROMPT_ROUTES,
  ...DEFER_ROUTES,
  ...CONVERSATION_QUERY_ROUTES,
  ...CONVERSATION_STARTER_ROUTES,
  ...DEBUG_ROUTES,
  ...DIAGNOSTICS_ROUTES,
  ...DOCUMENT_ROUTES,
  ...EVENTS_ROUTES,
  ...FILING_ROUTES,
  ...GLOBAL_SEARCH_ROUTES,
  ...GROUP_ROUTES,
  ...GUARDIAN_ACTION_ROUTES,
  ...HEARTBEAT_ROUTES,
  ...HOME_FEED_ROUTES,
  ...HOME_STATE_ROUTES,
  ...HOST_APP_CONTROL_ROUTES,
  ...HOST_BASH_ROUTES,
  ...HOST_BROWSER_ROUTES,
  ...HOST_CU_ROUTES,
  ...HOST_FILE_ROUTES,
  ...HOST_TRANSFER_ROUTES,
  ...IDENTITY_ROUTES,
  ...INTERFACE_ROUTES,
  ...INTERNAL_OAUTH_ROUTES,
  ...INTERNAL_TWILIO_ROUTES,
  ...LOG_EXPORT_ROUTES,
  ...LLM_CALL_SITES_ROUTES,
  ...MEMORY_ITEM_ROUTES,
  ...MEMORY_V2_ROUTES,
  ...MIGRATION_ROLLBACK_ROUTES,
  ...MIGRATION_ROUTES,
  ...NOTIFICATION_ROUTES,
  ...OAUTH_APPS_ROUTES,
  ...OAUTH_PROVIDERS_ROUTES,
  ...PLAYGROUND_ROUTES,
  ...PROFILER_ROUTES,
  ...PS_ROUTES,
  ...RECORDING_ROUTES,
  ...RENAME_CONVERSATION_ROUTES,
  ...SCHEDULE_ROUTES,
  ...SECRET_ROUTES,
  ...SETTINGS_ROUTES,
  ...SKILL_ROUTES,
  ...SLACK_CHANNEL_ROUTES,
  ...SLACK_SHARE_ROUTES,
  ...STT_ROUTES,
  ...SUGGEST_TRUST_RULE_ROUTES,
  ...SUBAGENT_ROUTES,
  ...SURFACE_ACTION_ROUTES,
  ...SURFACE_CONTENT_ROUTES,
  ...TELEGRAM_ROUTES,
  ...TWILIO_ROUTES,
  ...TASK_ROUTES,
  ...TELEMETRY_ROUTES,
  ...TRACE_EVENT_ROUTES,
  ...TRUST_RULES_ROUTES,
  ...TTS_ROUTES,
  ...UI_REQUEST_ROUTES,
  ...UPGRADE_BROADCAST_ROUTES,
  ...USAGE_ROUTES,
  ...VERCEL_ROUTES,
  ...WORK_ITEM_ROUTES,
  ...WATCHER_ROUTES,
  ...WIPE_CONVERSATION_ROUTES,
  ...WORKSPACE_COMMIT_ROUTES,
  ...WAKE_CONVERSATION_ROUTES,
  ...WORKSPACE_ROUTES,

  // User-defined routes under /x/* — MUST be last so built-in routes
  // always take priority over the catch-all pattern.
  ...USER_ROUTES,
];
