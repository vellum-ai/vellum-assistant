/**
 * Default `memory` conversations-cleared hook.
 *
 * The clear-all reset wipes every conversation in one bulk delete on the main
 * connection. SQLite foreign keys cannot span database files, so that delete
 * never reaches the per-conversation memory tables relocated to the dedicated
 * memory connection. This hook replaces the lost cascade with a wholesale wipe
 * of those tables. Best-effort, mirroring the `conversation-deleted` hook: an
 * unavailable memory database or a single failing table never breaks the reset.
 */

import type {
  ConversationsClearedContext,
  HookFunction,
} from "@vellumai/plugin-api";

import { clearAllConversationMemoryTables } from "../conversation-memory-purge.js";

const conversationsCleared: HookFunction<
  ConversationsClearedContext
> = async () => {
  clearAllConversationMemoryTables();
};

export default conversationsCleared;
