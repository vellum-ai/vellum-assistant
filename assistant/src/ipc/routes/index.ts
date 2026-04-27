import type { IpcRoute } from "../assistant-server.js";
import { attachmentRoutes } from "./attachment.js";
import { avatarNotifyRoute } from "./avatar-notify.js";
import { browserExecuteRoute } from "./browser.js";
import { cacheRoutes } from "./cache.js";
import { credentialPromptRoute } from "./credential-prompt.js";
import { deferRoutes } from "./defer.js";
import { getContactRoute } from "./get-contact.js";
import { listClientsRoute } from "./list-clients.js";
import { mergeContactsRoute } from "./merge-contacts.js";
import { notificationRoutes } from "./notification.js";
import { renameConversationRoute } from "./rename-conversation.js";
import { searchContactsRoute } from "./search-contacts.js";
import { secretsRoutes } from "./secrets.js";
import { suggestTrustRuleRoute } from "./suggest-trust-rule.js";
import { taskTemplateRoutes } from "./task.js";
import { taskQueueRoutes } from "./task-queue.js";
import { uiRequestRoute } from "./ui-request.js";
import { upsertContactRoute } from "./upsert-contact.js";
import { wakeConversationRoute } from "./wake-conversation.js";
import { watcherRoutes } from "./watcher.js";
import { wipeConversationRoute } from "./wipe-conversation.js";

/** All built-in CLI IPC routes. */
export const cliIpcRoutes: IpcRoute[] = [
  ...attachmentRoutes,
  avatarNotifyRoute,
  browserExecuteRoute,
  credentialPromptRoute,
  ...deferRoutes,
  getContactRoute,
  listClientsRoute,
  mergeContactsRoute,
  renameConversationRoute,
  searchContactsRoute,
  ...secretsRoutes,
  suggestTrustRuleRoute,
  uiRequestRoute,
  upsertContactRoute,
  wakeConversationRoute,
  wipeConversationRoute,
  ...notificationRoutes,
  ...cacheRoutes,
  ...taskTemplateRoutes,
  ...taskQueueRoutes,
  ...watcherRoutes,
];
