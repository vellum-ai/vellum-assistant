/**
 * Daemon message catalog.
 *
 * Keys are the stable identity of a piece of user-facing copy. English is
 * the source language. Add a key here, then add the same key to every
 * locale catalog. A key present in a translated catalog but missing from
 * English is a test failure.
 *
 * Persist the key, or the English default when a column already stores
 * English (conversation titles). Never persist a translated string:
 * replaceability and locale switching both break if the stored bytes
 * depend on the writer's locale.
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

/**
 * Values that may already be stored for a key. Conversation titles were
 * written as English placeholders before this catalog existed; those
 * strings stay replaceable and still classify as the same key.
 */
export const STORED_MESSAGE_ALIASES: Record<MessageKey, readonly string[]> = {
  "conversation.title.generating": [
    "Generating title...",
    "Generating title…",
  ],
  "conversation.title.untitled": ["Untitled Conversation", "Untitled"],
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

/**
 * Which catalog key a stored string is, if it is one of this module's
 * system constants (the key itself or a known stored alias).
 */
export function messageKeyFromStored(
  value: string | null | undefined,
): MessageKey | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }
  if (isMessageKey(trimmed)) {
    return trimmed;
  }
  for (const [key, aliases] of Object.entries(STORED_MESSAGE_ALIASES) as Array<
    [MessageKey, readonly string[]]
  >) {
    if (aliases.includes(trimmed)) {
      return key;
    }
  }
  return null;
}
