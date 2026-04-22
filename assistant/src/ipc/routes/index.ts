import type { IpcRoute } from "../cli-server.js";
import { attachmentRoutes } from "./attachment.js";
import { browserExecuteRoute } from "./browser.js";
import { cacheRoutes } from "./cache.js";
import { getContactRoute } from "./get-contact.js";
import { listClientsRoute } from "./list-clients.js";
import { mergeContactsRoute } from "./merge-contacts.js";
import { searchContactsRoute } from "./search-contacts.js";
import { taskTemplateRoutes } from "./task.js";
import { taskQueueRoutes } from "./task-queue.js";
import { uiRequestRoute } from "./ui-request.js";
import { upsertContactRoute } from "./upsert-contact.js";
import { wakeConversationRoute } from "./wake-conversation.js";
import { watcherRoutes } from "./watcher.js";

/** All built-in CLI IPC routes. */
export const cliIpcRoutes: IpcRoute[] = [
  ...attachmentRoutes,
  browserExecuteRoute,
  getContactRoute,
  listClientsRoute,
  mergeContactsRoute,
  searchContactsRoute,
  uiRequestRoute,
  upsertContactRoute,
  wakeConversationRoute,
  ...cacheRoutes,
  ...taskTemplateRoutes,
  ...taskQueueRoutes,
  ...watcherRoutes,
];
