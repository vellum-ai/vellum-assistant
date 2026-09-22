import { useTranslation } from "@/i18n";
import type { FeedItem } from "@vellumai/assistant-api";

import { getFeedItemUpdates, groupFeedItemUpdates } from "../utils";

/**
 * The title of a skill-update receipt, in the reader's language, or `null`
 * for any other item.
 *
 * The daemon writes the receipt's `title` in English as the fallback for
 * surfaces that render the item as it arrived. Every surface that names a
 * receipt derives the title here instead, from the entries the item carries:
 * one skill is named, several are counted, and the count is of skills rather
 * than rewrites, since a skill rewritten twice is still one thing that
 * changed. A hook rather than a helper so the copy follows a language switch.
 */
export function useFeedItemReceiptTitle(item: FeedItem | null): string | null {
  const { t } = useTranslation("home");
  const groups = groupFeedItemUpdates(getFeedItemUpdates(item));
  if (groups.length === 0) {
    return null;
  }
  const [only] = groups;
  if (groups.length === 1 && only) {
    return t("homeUpdatesList.titleOne", { name: only.name });
  }
  return t("homeUpdatesList.titleMany", { count: groups.length });
}
