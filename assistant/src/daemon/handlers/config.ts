/**
 * Config handler barrel — re-exports direct handler entry points for tests and
 * feature code. The aggregate dispatch map now lives in config-dispatch.ts so
 * direct imports do not participate in the runtime handler graph.
 */

// Re-export individual handlers for direct import by tests and other modules
export {
  getReadinessService,
  handleChannelVerificationSession,
} from "./config-channels.js";
export {
  handleHeartbeatChecklistRead,
  handleHeartbeatChecklistWrite,
  handleHeartbeatConfig,
  handleHeartbeatRunNow,
  handleHeartbeatRunsList,
} from "./config-heartbeat.js";
export {
  computeGatewayTarget,
  handleIngressConfig,
  syncTwilioWebhooks,
  triggerGatewayReconcile,
} from "./config-ingress.js";
export {
  handleTwitterIntegrationConfig,
  handleVercelApiConfig,
} from "./config-integrations.js";
export {
  handleImageGenModelSet,
  handleModelGet,
  handleModelSet,
} from "./config-model.js";
export { handlePlatformConfig } from "./config-platform.js";
export {
  handleReminderCancel,
  handleRemindersList,
  handleScheduleRemove,
  handleScheduleRunNow,
  handleSchedulesList,
  handleScheduleToggle,
} from "./config-scheduling.js";
export { handleSlackWebhookConfig } from "./config-slack.js";
export {
  handleTelegramConfig,
  summarizeTelegramError,
} from "./config-telegram.js";
export {
  handleEnvVarsRequest,
  handleToolNamesList,
  handleToolPermissionSimulate,
} from "./config-tools.js";
export {
  handleAcceptStarterBundle,
  handleAddTrustRule,
  handleRemoveTrustRule,
  handleTrustRulesList,
  handleUpdateTrustRule,
} from "./config-trust.js";
export {
  broadcastClientSettingsUpdate,
  handleVoiceConfigUpdate,
  normalizeActivationKey,
} from "./config-voice.js";
