/** Resolve persisted daemon-authored assistant text at a presentation edge. */

import { DEFAULT_LOCALE, type SupportedLocale } from "./locales.js";
import { isMessageKey, t } from "./messages.js";

export function resolveStoredMessageText(
  text: string,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const trimmed = text.trim();
  if (!isMessageKey(trimmed)) {
    return text;
  }
  const start = text.indexOf(trimmed);
  return `${text.slice(0, start)}${t(trimmed, locale)}${text.slice(
    start + trimmed.length,
  )}`;
}
