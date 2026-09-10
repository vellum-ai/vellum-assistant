/**
 * Display copy for a conversation title.
 *
 * The daemon localizes hardcoded title constants before they reach the
 * client. An empty title is the only local fallback.
 */

import { t, useTranslation, type TFunction } from "@/i18n";

export function resolveConversationTitleDisplay(
  title: string | null | undefined,
  untitled: string,
): string {
  const trimmed = title?.trim() ?? "";
  if (trimmed === "") {
    return untitled;
  }
  return trimmed;
}

export function displayConversationTitle(
  title: string | null | undefined,
  translate: TFunction = t,
): string {
  return resolveConversationTitleDisplay(
    title,
    translate("conversationTitle.untitled"),
  );
}

export function useDisplayConversationTitle(): (
  title: string | null | undefined,
) => string {
  const { t: translate } = useTranslation();
  return (title) => displayConversationTitle(title, translate);
}
