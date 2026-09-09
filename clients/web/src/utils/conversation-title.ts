/**
 * Display copy for a conversation title.
 *
 * Untitled vs generating is a condition (`titleState`, or an empty title),
 * not a match against the title string. The daemon owns those constants
 * (`assistant/src/i18n`) and emits `titleState` on summaries and title
 * events. Older daemons omit the field; an empty title still falls back
 * to untitled.
 */

import { t, useTranslation, type TFunction } from "@/i18n";

export type ConversationTitleState = "generating" | "untitled";

export function resolveConversationTitleDisplay(
  title: string | null | undefined,
  copy: { generating: string; untitled: string },
  titleState?: ConversationTitleState | null,
): string {
  if (titleState === "generating") {
    return copy.generating;
  }
  const trimmed = title?.trim() ?? "";
  if (titleState === "untitled" || trimmed === "") {
    return copy.untitled;
  }
  return trimmed;
}

export function displayConversationTitle(
  title: string | null | undefined,
  translate: TFunction = t,
  titleState?: ConversationTitleState | null,
): string {
  return resolveConversationTitleDisplay(
    title,
    {
      generating: translate("conversationTitle.generating"),
      untitled: translate("conversationTitle.untitled"),
    },
    titleState,
  );
}

export function useDisplayConversationTitle(): (
  title: string | null | undefined,
  titleState?: ConversationTitleState | null,
) => string {
  const { t: translate } = useTranslation();
  return (title, titleState) =>
    displayConversationTitle(title, translate, titleState);
}
