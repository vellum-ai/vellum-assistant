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
 *   config-integrations.ts — Vercel API & Twitter integration
 *   config-telegram.ts    — Telegram bot configuration
 *   config-twilio.ts      — Twilio SMS/voice configuration
 *   config-channels.ts    — Channel guardian & readiness
 *   config-tools.ts       — Env vars, tool permission simulation, tool names
 */

// Re-export individual handlers for direct import by tests and other modules
export { handleModelGet, handleModelSet, handleImageGenModelSet } from './config-model.js';
export { handleAddTrustRule, handleTrustRulesList, handleRemoveTrustRule, handleUpdateTrustRule, handleAcceptStarterBundle } from './config-trust.js';
export { handleSchedulesList, handleScheduleToggle, handleScheduleRemove, handleScheduleRunNow, handleRemindersList, handleReminderCancel } from './config-scheduling.js';
export { handleShareToSlack, handleSlackWebhookConfig } from './config-slack.js';
export { handleIngressConfig, computeGatewayTarget, triggerGatewayReconcile, syncTwilioWebhooks } from './config-ingress.js';
export { handleVercelApiConfig, handleTwitterIntegrationConfig } from './config-integrations.js';
export { handleTelegramConfig, summarizeTelegramError } from './config-telegram.js';
export { handleTwilioConfig } from './config-twilio.js';
export { handleGuardianVerification, handleChannelReadiness, getReadinessService } from './config-channels.js';
export { handleEnvVarsRequest, handleToolPermissionSimulate, handleToolNamesList } from './config-tools.js';

// Assemble the combined dispatch map from domain-specific handler groups
import { modelHandlers } from './config-model.js';
import { trustHandlers } from './config-trust.js';
import { schedulingHandlers } from './config-scheduling.js';
import { slackHandlers } from './config-slack.js';
import { ingressHandlers } from './config-ingress.js';
import { integrationHandlers } from './config-integrations.js';
import { telegramHandlers } from './config-telegram.js';
import { twilioHandlers } from './config-twilio.js';
import { channelHandlers } from './config-channels.js';
import { toolHandlers } from './config-tools.js';

export const configHandlers = {
  ...modelHandlers,
  ...trustHandlers,
  ...schedulingHandlers,
  ...slackHandlers,
  ...ingressHandlers,
  ...integrationHandlers,
  ...telegramHandlers,
  ...twilioHandlers,
  ...channelHandlers,
  ...toolHandlers,
};
