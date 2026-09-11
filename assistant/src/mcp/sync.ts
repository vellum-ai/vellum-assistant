import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";

export async function publishMcpChanged(): Promise<void> {
  await publishSyncInvalidation([SYNC_TAGS.mcpList]);
}
