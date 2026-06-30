import { getConfig } from "../../../config/loader.js";
import type {
  MemoryPersistenceHooks,
  MessagePersistedEvent,
} from "../../../persistence/memory-lifecycle-hooks.js";
import { indexMessageNow } from "./indexer.js";

/**
 * The memory feature's implementation of the persistence lifecycle seam
 * (`MemoryPersistenceHooks`). Registered into the seam at plugin bootstrap so
 * the persistence layer can drive memory side effects without importing memory
 * internals.
 */
export const memoryPersistenceHooks: MemoryPersistenceHooks = {
  async onMessagePersisted(event: MessagePersistedEvent): Promise<void> {
    await indexMessageNow({ ...event, scopeId: "default" }, getConfig().memory);
  },
};
