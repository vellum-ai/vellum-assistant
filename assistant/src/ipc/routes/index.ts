import type { IpcRoute } from "../cli-server.js";
import { browserExecuteRoute } from "./browser.js";
import { cacheRoutes } from "./cache.js";
import { taskTemplateRoutes } from "./task.js";
import { taskQueueRoutes } from "./task-queue.js";
import { uiRequestRoute } from "./ui-request.js";
import { wakeConversationRoute } from "./wake-conversation.js";
import { watcherRoutes } from "./watcher.js";

/** All built-in CLI IPC routes. */
export const cliIpcRoutes: IpcRoute[] = [
  browserExecuteRoute,
  uiRequestRoute,
  wakeConversationRoute,
  ...cacheRoutes,
  ...taskTemplateRoutes,
  ...taskQueueRoutes,
  ...watcherRoutes,
];
