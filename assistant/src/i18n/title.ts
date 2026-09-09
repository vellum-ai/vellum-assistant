/**
 * Conversation-title classification for stored title constants.
 *
 * The title column holds a real title, a system constant (message key or
 * legacy English placeholder), or empty. Callers that emit user-facing
 * copy resolve the constant through {@link resolveConversationTitle}.
 * Callers that need a condition (serializer `titleState`, replaceability)
 * use {@link classifyConversationTitle}.
 */

import { DEFAULT_LOCALE, type SupportedLocale } from "./locales.js";
import {
  MESSAGE_KEYS,
  messageKeyFromStored,
  t,
} from "./messages.js";

export type ConversationTitleState = "generating" | "untitled" | "custom";

export function classifyConversationTitle(
  title: string | null | undefined,
): ConversationTitleState {
  const trimmed = title?.trim() ?? "";
  if (trimmed === "") {
    return "untitled";
  }
  const key = messageKeyFromStored(trimmed);
  if (key === MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING) {
    return "generating";
  }
  if (key === MESSAGE_KEYS.CONVERSATION_TITLE_UNTITLED) {
    return "untitled";
  }
  return "custom";
}

/**
 * Display form of a stored title for a locale. Custom titles pass through.
 * System constants resolve through the catalog.
 */
export function resolveConversationTitle(
  title: string | null | undefined,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const state = classifyConversationTitle(title);
  if (state === "generating") {
    return t(MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING, locale);
  }
  if (state === "untitled") {
    return t(MESSAGE_KEYS.CONVERSATION_TITLE_UNTITLED, locale);
  }
  return title!.trim();
}
