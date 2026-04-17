import type { IpcRoute } from "../cli-server.js";
import { browserExecuteRoute } from "./browser.js";
import { wakeConversationRoute } from "./wake-conversation.js";

/** All built-in CLI IPC routes. */
export const cliIpcRoutes: IpcRoute[] = [
  browserExecuteRoute,
  wakeConversationRoute,
];
