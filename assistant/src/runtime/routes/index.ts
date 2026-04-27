/**
 * Shared route definitions served by BOTH the HTTP server and the IPC server.
 *
 * Routes listed here are registered in the HTTP router (via buildRouteTable)
 * and exposed as IPC methods on the AssistantIpcServer (via cliIpcRoutes).
 *
 * Over time, routes will migrate from their HTTP-only or IPC-only homes
 * into this shared array.
 */

import { ROUTES as ACP_ROUTES } from "./acp-routes.js";
import { ROUTES as APP_MANAGEMENT_ROUTES } from "./app-management-routes.js";
import { ROUTES as APP_ROUTES } from "./app-routes.js";
import { ROUTES as APPROVAL_ROUTES } from "./approval-routes.js";
import { ROUTES as AUDIO_ROUTES } from "./audio-routes.js";
import { ROUTES as AVATAR_ROUTES } from "./avatar-routes.js";
import { ROUTES as BACKUP_ROUTES } from "./backup-routes.js";
import { ROUTES as BRAIN_GRAPH_ROUTES } from "./brain-graph-routes.js";
import { ROUTES as CALL_ROUTES } from "./call-routes.js";
import { ROUTES as CLIENT_ROUTES } from "./client-routes.js";
import { ROUTES as CONVERSATION_ATTENTION_ROUTES } from "./conversation-attention-routes.js";
import { ROUTES as CONVERSATION_STARTER_ROUTES } from "./conversation-starter-routes.js";
import { ROUTES as DEBUG_ROUTES } from "./debug-routes.js";
import { ROUTES as GLOBAL_SEARCH_ROUTES } from "./global-search-routes.js";
import { ROUTES as GROUP_ROUTES } from "./group-routes.js";
import { ROUTES as HOME_STATE_ROUTES } from "./home-state-routes.js";
import { ROUTES as IDENTITY_ROUTES } from "./identity-routes.js";
import { ROUTES as INVITE_ROUTES } from "./invite-routes.js";
import { ROUTES as PS_ROUTES } from "./ps-routes.js";
import { ROUTES as RENAME_CONVERSATION_ROUTES } from "./rename-conversation-routes.js";
import { ROUTES as TELEMETRY_ROUTES } from "./telemetry-routes.js";
import { ROUTES as TRACE_EVENT_ROUTES } from "./trace-event-routes.js";
import type { RouteDefinition } from "./types.js";
import { ROUTES as UPGRADE_BROADCAST_ROUTES } from "./upgrade-broadcast-routes.js";
import { ROUTES as USAGE_ROUTES } from "./usage-routes.js";
import { ROUTES as WORK_ITEM_ROUTES } from "./work-items-routes.js";
import { ROUTES as WORKSPACE_COMMIT_ROUTES } from "./workspace-commit-routes.js";
import { ROUTES as WORKSPACE_ROUTES } from "./workspace-routes.js";

export const ROUTES: RouteDefinition[] = [
  ...ACP_ROUTES,
  ...APP_MANAGEMENT_ROUTES,
  ...APP_ROUTES,
  ...APPROVAL_ROUTES,
  ...AUDIO_ROUTES,
  ...AVATAR_ROUTES,
  ...BACKUP_ROUTES,
  ...CALL_ROUTES,
  ...BRAIN_GRAPH_ROUTES,
  ...CLIENT_ROUTES,
  ...CONVERSATION_ATTENTION_ROUTES,
  ...CONVERSATION_STARTER_ROUTES,
  ...DEBUG_ROUTES,
  ...GLOBAL_SEARCH_ROUTES,
  ...GROUP_ROUTES,
  ...HOME_STATE_ROUTES,
  ...IDENTITY_ROUTES,
  ...INVITE_ROUTES,
  ...PS_ROUTES,
  ...RENAME_CONVERSATION_ROUTES,
  ...TELEMETRY_ROUTES,
  ...TRACE_EVENT_ROUTES,
  ...UPGRADE_BROADCAST_ROUTES,
  ...USAGE_ROUTES,
  ...WORK_ITEM_ROUTES,
  ...WORKSPACE_COMMIT_ROUTES,
  ...WORKSPACE_ROUTES,
];
