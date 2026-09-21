/**
 * Resolve a daemon-generated user message for a locale.
 *
 * A payload that carries a catalog key resolves through the catalog. One
 * without a key, or with a key this build does not know, keeps the text it
 * already has.
 */

import { DEFAULT_LOCALE, type SupportedLocale } from "./locales.js";
import { isMessageKey, t } from "./messages.js";

export function resolveUserMessage(
  userMessage: string,
  userMessageKey: string | null | undefined,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  return userMessageKey && isMessageKey(userMessageKey)
    ? t(userMessageKey, locale)
    : userMessage;
}
