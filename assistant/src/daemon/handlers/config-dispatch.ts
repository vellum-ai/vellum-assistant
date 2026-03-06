import { channelHandlers } from "./config-channels.js";
import { heartbeatHandlers } from "./config-heartbeat.js";
import { ingressHandlers } from "./config-ingress.js";
import { integrationHandlers } from "./config-integrations.js";
import { modelHandlers } from "./config-model.js";
import { platformHandlers } from "./config-platform.js";
import { schedulingHandlers } from "./config-scheduling.js";
import { slackHandlers } from "./config-slack.js";
import { telegramHandlers } from "./config-telegram.js";
import { toolHandlers } from "./config-tools.js";
import { trustHandlers } from "./config-trust.js";
import { voiceHandlers } from "./config-voice.js";

// Keep the dispatch map isolated from the public config barrel so direct
// handler imports do not race with index.ts when Bun evaluates modules eagerly.
export const configHandlers = {
  ...modelHandlers,
  ...trustHandlers,
  ...schedulingHandlers,
  ...slackHandlers,
  ...ingressHandlers,
  ...platformHandlers,
  ...integrationHandlers,
  ...telegramHandlers,
  ...channelHandlers,
  ...toolHandlers,
  ...heartbeatHandlers,
  ...voiceHandlers,
};
