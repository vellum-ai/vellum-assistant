/**
 * Fan out an app change to open conversation surfaces, connected clients,
 * and the publish pipeline.
 *
 * Compilation is the caller's responsibility. This module only notifies:
 * it must not call `compileApp()` because that begins with `rm -rf dist/`
 * and would race a compile already in flight.
 */

import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { publishAppsChanged } from "../runtime/sync/resource-sync-events.js";
import { updatePublishedAppDeployment } from "../services/published-app-updater.js";
import type { Conversation } from "./conversation.js";
import { allConversations } from "./conversation-registry.js";
import { refreshSurfacesForApp } from "./conversation-surfaces.js";

export function broadcastAppFilesChanged(appId: string): void {
  broadcastMessage({ type: "app_files_changed", appId });
  publishAppsChanged();
}

/**
 * Refresh every in-memory conversation that has this app open, then broadcast
 * and re-deploy. Pass `alsoRefresh` when the calling conversation might not
 * yet be in the registry (tool post-execution hooks).
 */
export function notifyAppSurfacesChanged(
  appId: string,
  opts?: { fileChange?: boolean; status?: string },
  alsoRefresh?: Conversation,
): void {
  const seen = new Set<string>();
  if (alsoRefresh) {
    refreshSurfacesForApp(alsoRefresh, appId, opts);
    seen.add(alsoRefresh.conversationId);
  }
  for (const conversation of allConversations()) {
    if (seen.has(conversation.conversationId)) {
      continue;
    }
    refreshSurfacesForApp(conversation, appId, opts);
  }
  broadcastAppFilesChanged(appId);
  void updatePublishedAppDeployment(appId);
}
