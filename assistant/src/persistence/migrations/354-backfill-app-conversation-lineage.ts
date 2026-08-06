import {
  isDirectAppConversation,
  linkAppToConversationLineage,
  listApps,
} from "../../apps/app-store.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("migration:backfill-app-conversation-lineage");

/**
 * Populate inherited ancestor associations for every app conversation that is
 * direct. Processing only direct associations keeps the migration idempotent:
 * an inherited ancestor never becomes a new lineage seed on a later run.
 */
export function migrateBackfillAppConversationLineage(): void {
  let appsUpdated = 0;
  let associationsAdded = 0;

  for (const app of listApps()) {
    let appUpdated = false;
    for (const conversationId of app.conversationIds ?? []) {
      if (!isDirectAppConversation(app, conversationId)) {
        continue;
      }
      const added = linkAppToConversationLineage(app.id, conversationId);
      if (added > 0) {
        associationsAdded += added;
        appUpdated = true;
      }
    }

    if (appUpdated) {
      appsUpdated += 1;
    }
  }

  log.info(
    { appsUpdated, associationsAdded },
    "Backfilled app conversation lineage",
  );
}
