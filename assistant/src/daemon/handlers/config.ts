/**
 * Config handler barrel — re-exports all config domain handlers and assembles
 * the combined `configHandlers` dispatch map.
 *
 * Individual handlers live in domain-specific files:
 *   config-model.ts       — Model selection (LLM + image gen)
 *   config-trust.ts       — Trust rules (permissions allowlist)
 *   config-scheduling.ts  — Schedules & reminders
 *   config-slack.ts       — Slack webhook sharing
 *   config-ingress.ts     — Public ingress URL & gateway reconciliation
 *   config-platform.ts    — Platform base URL configuration
 *   config-integrations.ts — Vercel API & Twitter integration
 *   config-telegram.ts    — Telegram bot configuration
 *   config-twilio.ts      — Twilio SMS/voice configuration
 *   config-channels.ts    — Channel guardian & readiness
 *   config-tools.ts       — Env vars, tool permission simulation, tool names
 *   config-parental.ts    — Parental control PIN + content/tool restrictions
 */

// Re-export individual handlers for direct import by tests and other modules
export { getReadinessService,handleChannelReadiness, handleGuardianVerification } from './config-channels.js';
export { handleHeartbeatChecklistRead, handleHeartbeatChecklistWrite,handleHeartbeatConfig, handleHeartbeatRunNow, handleHeartbeatRunsList } from './config-heartbeat.js';
export { computeGatewayTarget, handleIngressConfig, syncTwilioWebhooks,triggerGatewayReconcile } from './config-ingress.js';
export { handleTwitterIntegrationConfig,handleVercelApiConfig } from './config-integrations.js';
export { handleImageGenModelSet,handleModelGet, handleModelSet } from './config-model.js';
export { handleParentalControlGet, handleParentalControlSetPin, handleParentalControlUpdate,handleParentalControlVerifyPin } from './config-parental.js';
export { handlePlatformConfig } from './config-platform.js';
export { handleReminderCancel,handleRemindersList, handleScheduleRemove, handleScheduleRunNow, handleSchedulesList, handleScheduleToggle } from './config-scheduling.js';
export { handleShareToSlack, handleSlackWebhookConfig } from './config-slack.js';
export { handleTelegramConfig, summarizeTelegramError } from './config-telegram.js';
export { handleEnvVarsRequest, handleToolNamesList,handleToolPermissionSimulate } from './config-tools.js';
export { handleAcceptStarterBundle,handleAddTrustRule, handleRemoveTrustRule, handleTrustRulesList, handleUpdateTrustRule } from './config-trust.js';
export { handleTwilioConfig } from './config-twilio.js';

// Assemble the combined dispatch map from domain-specific handler groups
import { channelHandlers } from './config-channels.js';
import { heartbeatHandlers } from './config-heartbeat.js';
import { ingressHandlers } from './config-ingress.js';
import { integrationHandlers } from './config-integrations.js';
import { modelHandlers } from './config-model.js';
import { parentalControlHandlers } from './config-parental.js';
import { platformHandlers } from './config-platform.js';
import { schedulingHandlers } from './config-scheduling.js';
import { slackHandlers } from './config-slack.js';
import { telegramHandlers } from './config-telegram.js';
import { toolHandlers } from './config-tools.js';
import { trustHandlers } from './config-trust.js';
import { twilioHandlers } from './config-twilio.js';

export const configHandlers = {
  ...modelHandlers,
  ...trustHandlers,
  ...schedulingHandlers,
  ...slackHandlers,
  ...ingressHandlers,
  ...platformHandlers,
  ...integrationHandlers,
  ...telegramHandlers,
  ...twilioHandlers,
  ...channelHandlers,
  ...toolHandlers,
  ...parentalControlHandlers,
  ...heartbeatHandlers,
};
