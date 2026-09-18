import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import type { AssistantConfig } from "./schema.js";

export const SIDEBAR_DONE_FLAG_KEY = "sidebar-done" as const;

/**
 * Whether archiving a chat means marking it done.
 *
 * The flag is `both`-scoped: clients gate the Done affordances and the Old
 * chats page on it, and the daemon gates the read-side halves the feature
 * needs. On the daemon side that is search reach, and nothing else. Done is
 * `archived_at`, so no row changes shape in either state.
 *
 * Off, an archived conversation is hidden from search unless the query names
 * it (`is:archived`). On, a done chat is findable by default and
 * `is:unarchived` is the opt-out, because a chat the user marked done is
 * filed, not deleted, and search is how they get back to it.
 */
export function isSidebarDoneEnabled(config?: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(SIDEBAR_DONE_FLAG_KEY, config);
}
