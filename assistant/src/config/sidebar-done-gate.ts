import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import type { AssistantConfig } from "./schema.js";

export const SIDEBAR_DONE_FLAG_KEY = "sidebar-done" as const;

/**
 * Whether archiving a chat means marking it done.
 *
 * The flag is `both`-scoped: clients gate the Done affordances and the Old
 * chats page on it, and the daemon gates the halves the feature needs. Done is
 * `archived_at`, so no row changes shape in either state.
 *
 * On the daemon side there are two. The first is search reach: off, an
 * archived conversation is hidden from search unless the query names it
 * (`is:archived`); on, a done chat is findable by default and `is:unarchived`
 * is the opt-out, because a chat the user marked done is filed, not deleted,
 * and search is how they get back to it.
 *
 * The second is that a done chat keeps working. Off, an archived conversation
 * rejects every wake and nothing but the unarchive route clears the column, so
 * marking a chat done silently kills its schedule or its channel thread. On, a
 * wake still runs on it, and a message the user reads landing in it brings the
 * conversation back to the list.
 */
export function isSidebarDoneEnabled(config?: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(SIDEBAR_DONE_FLAG_KEY, config);
}
