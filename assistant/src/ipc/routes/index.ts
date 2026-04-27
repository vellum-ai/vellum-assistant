import { ROUTES } from "../../runtime/routes/index.js";
import type { IpcRoute } from "../assistant-server.js";
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

  ...taskTemplateRoutes,
  ...taskQueueRoutes,
  ...watcherRoutes,
  ...routeDefinitionsToIpcRoutes(ROUTES),
];
