/**
 * Daemon message catalog.
 *
 * Keys are the stable identity of a hardcoded constant. English is the
 * source language. Add a key here, then add the same key to every locale
 * catalog. A key present in a translated catalog but missing from English
 * is a test failure.
 *
 * Persist the key when a column holds a system constant. Never persist a
 * translated string, and never treat a stored display string as a key:
 * a user title may be in any language.
 */

import {
  DEFAULT_LOCALE,
  type SupportedLocale,
} from "./locales.js";

export const MESSAGE_KEYS = {
  CONVERSATION_TITLE_GENERATING: "conversation.title.generating",
  CONVERSATION_TITLE_UNTITLED: "conversation.title.untitled",
} as const;

export type MessageKey = (typeof MESSAGE_KEYS)[keyof typeof MESSAGE_KEYS];

export const MESSAGE_CATALOGS: Record<
  SupportedLocale,
  Record<MessageKey, string>
> = {
  en: {
    "conversation.title.generating": "Generating title...",
    "conversation.title.untitled": "Untitled Conversation",
  },
  es: {
    "conversation.title.generating": "Generando título...",
    "conversation.title.untitled": "Sin título",
  },
  ru: {
    "conversation.title.generating": "Создание названия...",
    "conversation.title.untitled": "Без названия",
  },
  zh: {
    "conversation.title.generating": "标题生成中...",
    "conversation.title.untitled": "无标题",
  },
  "zh-TW": {
    "conversation.title.generating": "標題產生中...",
    "conversation.title.untitled": "未命名",
  },
};

export function t(
  key: MessageKey,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  return MESSAGE_CATALOGS[locale][key] ?? MESSAGE_CATALOGS[DEFAULT_LOCALE][key];
}

export function isMessageKey(value: string): value is MessageKey {
  return (Object.values(MESSAGE_KEYS) as string[]).includes(value);
}
