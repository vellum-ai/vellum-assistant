import type { IpcRoute } from "../cli-server.js";
import { attachmentRoutes } from "./attachment.js";
import { browserExecuteRoute } from "./browser.js";
import { cacheRoutes } from "./cache.js";
import { uiRequestRoute } from "./ui-request.js";
import { wakeConversationRoute } from "./wake-conversation.js";
import { watcherRoutes } from "./watcher.js";

/** All built-in CLI IPC routes. */
export const cliIpcRoutes: IpcRoute[] = [
  ...attachmentRoutes,
  browserExecuteRoute,
  uiRequestRoute,
  wakeConversationRoute,
  ...cacheRoutes,
  ...watcherRoutes,
];
