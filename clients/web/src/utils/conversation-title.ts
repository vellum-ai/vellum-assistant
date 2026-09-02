/**
 * Map daemon title sentinels to locale-aware display copy.
 *
 * The assistant persists English placeholders (`Generating title...`,
 * `Untitled Conversation`) so replaceability stays a stable string match.
 * Clients localize those sentinels at the edge that draws the title.
 */

import { t, useTranslation, type TFunction } from "@/i18n";

export const GENERATING_TITLE_SENTINEL = "Generating title...";
export const UNTITLED_CONVERSATION_SENTINEL = "Untitled Conversation";
export const UNTITLED_SENTINEL = "Untitled";

const GENERATING_TITLE_SENTINELS = new Set([
  GENERATING_TITLE_SENTINEL,
  "Generating title…",
]);

const UNTITLED_SENTINELS = new Set([
  UNTITLED_SENTINEL,
  UNTITLED_CONVERSATION_SENTINEL,
]);

export function resolveConversationTitleDisplay(
  title: string | null | undefined,
  copy: { generating: string; untitled: string },
): string {
  const trimmed = title?.trim() ?? "";
  if (GENERATING_TITLE_SENTINELS.has(trimmed)) {
    return copy.generating;
  }
  if (trimmed === "" || UNTITLED_SENTINELS.has(trimmed)) {
    return copy.untitled;
  }
  return trimmed;
}

export function displayConversationTitle(
  title: string | null | undefined,
  translate: TFunction = t,
): string {
  return resolveConversationTitleDisplay(title, {
    generating: translate("conversationTitle.generating"),
    untitled: translate("conversationTitle.untitled"),
  });
}

export function useDisplayConversationTitle(): (
  title: string | null | undefined,
) => string {
  const { t: translate } = useTranslation();
  return (title) => displayConversationTitle(title, translate);
}
