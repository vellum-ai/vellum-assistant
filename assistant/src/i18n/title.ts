/**
 * Resolve a conversation title for a locale.
 *
 * A stored message key (or an empty title) is a hardcoded constant and
 * resolves through the catalog. Any other stored string is user or model
 * copy and passes through, including English placeholders written before
 * keys were persisted.
 */

import { DEFAULT_LOCALE, type SupportedLocale } from "./locales.js";
import { isMessageKey, MESSAGE_KEYS, t } from "./messages.js";

export function resolveConversationTitle(
  title: string | null | undefined,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const trimmed = title?.trim() ?? "";
  if (trimmed === "") {
    return t(MESSAGE_KEYS.CONVERSATION_TITLE_UNTITLED, locale);
  }
  if (isMessageKey(trimmed)) {
    return t(trimmed, locale);
  }
  return trimmed;
}
