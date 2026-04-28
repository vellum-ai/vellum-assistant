import { ROUTES } from "../../runtime/routes/index.js";
import type { IpcRoute } from "../assistant-server.js";
import { memoryV2BackfillRoute } from "./memory-v2-backfill.js";
import { memoryV2ValidateRoute } from "./memory-v2-validate.js";
import { routeDefinitionsToIpcRoutes } from "./route-adapter.js";
import { suggestTrustRuleRoute } from "./suggest-trust-rule.js";
import { taskTemplateRoutes } from "./task.js";
import { taskQueueRoutes } from "./task-queue.js";
import { trustRuleRoutes } from "./trust-rules.js";
import { uiRequestRoute } from "./ui-request.js";
import { watcherRoutes } from "./watcher.js";
import { wipeConversationRoute } from "./wipe-conversation.js";

/** All built-in CLI IPC routes. */
export const cliIpcRoutes: IpcRoute[] = [
  ...trustRuleRoutes,
  suggestTrustRuleRoute,
  uiRequestRoute,
  wipeConversationRoute,

  memoryV2BackfillRoute,
  memoryV2ValidateRoute,

  ...taskTemplateRoutes,
  ...taskQueueRoutes,
  ...watcherRoutes,
  ...routeDefinitionsToIpcRoutes(ROUTES),
];
