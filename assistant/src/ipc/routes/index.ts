import { ROUTES } from "../../runtime/routes/index.js";
import type { IpcRoute } from "../assistant-server.js";
import { credentialPromptRoute } from "./credential-prompt.js";
import { deferRoutes } from "./defer.js";
import { getContactRoute } from "./get-contact.js";
import { mergeContactsRoute } from "./merge-contacts.js";
import { notificationRoutes } from "./notification.js";
import { routeDefinitionsToIpcRoutes } from "./route-adapter.js";
import { routeSchemaRoute } from "./route-schema.js";
import { searchContactsRoute } from "./search-contacts.js";
import { secretsRoutes } from "./secrets.js";
import { suggestTrustRuleRoute } from "./suggest-trust-rule.js";
import { taskTemplateRoutes } from "./task.js";
import { taskQueueRoutes } from "./task-queue.js";
import { uiRequestRoute } from "./ui-request.js";
import { upsertContactRoute } from "./upsert-contact.js";
import { watcherRoutes } from "./watcher.js";
import { wipeConversationRoute } from "./wipe-conversation.js";

/** All built-in CLI IPC routes. */
export const cliIpcRoutes: IpcRoute[] = [


  credentialPromptRoute,
  ...deferRoutes,
  getContactRoute,
  mergeContactsRoute,
  searchContactsRoute,
  ...secretsRoutes,
  suggestTrustRuleRoute,
  uiRequestRoute,
  upsertContactRoute,
  wipeConversationRoute,
  ...notificationRoutes,

  ...taskTemplateRoutes,
  ...taskQueueRoutes,
  ...watcherRoutes,
  routeSchemaRoute,
  ...routeDefinitionsToIpcRoutes(ROUTES),
];
