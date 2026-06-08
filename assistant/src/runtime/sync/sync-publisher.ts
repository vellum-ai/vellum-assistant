import {
  buildSyncChangedMessage,
  type SyncChangedEvent,
  type SyncInvalidationTag,
} from "../../daemon/message-types/sync.js";
import { getLogger } from "../../util/logger.js";
import { broadcastMessage } from "../assistant-event-hub.js";

const log = getLogger("sync-publisher");

export async function publishSyncInvalidation(
  tags: SyncInvalidationTag[],
  originClientId?: string,
): Promise<SyncChangedEvent> {
  const message = buildSyncChangedMessage(tags, originClientId);
  try {
    broadcastMessage(message);
  } catch (err) {
    log.warn({ err, tags: message.tags }, "Failed to publish sync_changed");
  }
  return message;
}
