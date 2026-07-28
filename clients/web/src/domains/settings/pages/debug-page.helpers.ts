/**
 * Pure `?tab=` resolution for the Debug page, split out so the legacy-archive
 * mapping is testable without mounting the page's terminal/doctor panels.
 */

import type { ConversationFilter } from "@/domains/settings/hooks/use-all-conversations-data.helpers";

/**
 * `?tab=archive` predates the Conversations browser and is still what the
 * assistant's `navigate_settings_tab` tool and older bookmarks send. The
 * browser covers archived rows behind its own filter, so the param opens it
 * pre-filtered rather than resolving to a tab of its own.
 */
export const LEGACY_ARCHIVE_PARAM = "archive";

export function resolveDebugTabParam(tabParam: string | null): {
  tabId: string | null;
  conversationsFilter: ConversationFilter;
} {
  if (tabParam === LEGACY_ARCHIVE_PARAM) {
    return { tabId: "conversations", conversationsFilter: "archived" };
  }
  return { tabId: tabParam, conversationsFilter: "all" };
}
