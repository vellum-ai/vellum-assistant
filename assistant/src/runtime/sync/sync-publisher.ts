import type { SyncChange } from "../../daemon/message-types/sync.js";
import { buildSyncChangedMessage } from "../../daemon/message-types/sync.js";
import type { SyncChangeInput } from "../../memory/sync-change-store.js";
import { recordSyncChanges } from "../../memory/sync-change-store.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";

const log = getLogger("sync-publisher");

export interface PublishSyncChangesOptions {
  originClientId?: string;
  createdAt?: number;
  retentionRows?: number;
}

export async function publishSyncChanges(
  changes: SyncChangeInput[],
  options: PublishSyncChangesOptions = {},
): Promise<SyncChange[]> {
  const persisted = recordSyncChanges(changes, options);
  if (persisted.length === 0) {
    return persisted;
  }

  const message = buildSyncChangedMessage(persisted, options.originClientId);
  try {
    await assistantEventHub.publish(buildAssistantEvent(message));
  } catch (err) {
    log.warn({ err }, "Failed to publish sync_changed event");
  }
  return persisted;
}
