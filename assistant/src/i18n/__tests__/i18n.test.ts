import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LOCALE,
  isMessageKey,
  localeFromAcceptLanguage,
  MESSAGE_CATALOGS,
  MESSAGE_KEYS,
  negotiateLocale,
  resolveConversationTitle,
  SUPPORTED_LOCALES,
  t,
} from "../index.js";

describe("negotiateLocale", () => {
  test("matches a full shipped tag", () => {
    expect(negotiateLocale(["es"])).toBe("es");
    expect(negotiateLocale(["zh-TW"])).toBe("zh-TW");
  });

  test("falls back from a regional tag to the primary language", () => {
    expect(negotiateLocale(["es-MX", "en"])).toBe("es");
  });

  test("maps Traditional Chinese tags to zh-TW", () => {
    expect(negotiateLocale(["zh-Hant"])).toBe("zh-TW");
    expect(negotiateLocale(["zh-HK"])).toBe("zh-TW");
  });

  test("defaults when nothing matches", () => {
    expect(negotiateLocale([])).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(["xx"])).toBe(DEFAULT_LOCALE);
  });
});

describe("localeFromAcceptLanguage", () => {
  test("honors quality values", () => {
    expect(localeFromAcceptLanguage("fr;q=0.8, es;q=0.9, en;q=0.5")).toBe(
      "es",
    );
  });

  test("defaults on missing or empty", () => {
    expect(localeFromAcceptLanguage(null)).toBe(DEFAULT_LOCALE);
    expect(localeFromAcceptLanguage("")).toBe(DEFAULT_LOCALE);
  });
});

describe("catalog completeness", () => {
  test("every locale has every key", () => {
    const keys = Object.values(MESSAGE_KEYS);
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of keys) {
        expect(MESSAGE_CATALOGS[locale][key].length).toBeGreaterThan(0);
      }
    }
  });
});

describe("t", () => {
  test("resolves generating and untitled per locale", () => {
    expect(t(MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING, "en")).toBe(
      "Generating title...",
    );
    expect(t(MESSAGE_KEYS.CONVERSATION_TITLE_UNTITLED, "en")).toBe(
      "Untitled Conversation",
    );
    expect(t(MESSAGE_KEYS.CONVERSATION_TITLE_UNTITLED, "es")).toBe(
      "Sin título",
    );
  });
});

describe("resolveConversationTitle", () => {
  test("resolves a stored key and an empty title", () => {
    expect(
      resolveConversationTitle(MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING, "zh"),
    ).toBe("标题生成中...");
    expect(resolveConversationTitle(null, "es")).toBe("Sin título");
    expect(resolveConversationTitle("")).toBe("Untitled Conversation");
  });

  test("passes stored display strings through, including English placeholders", () => {
    expect(resolveConversationTitle("Untitled Conversation", "es")).toBe(
      "Untitled Conversation",
    );
    expect(resolveConversationTitle("Generating title...", "zh")).toBe(
      "Generating title...",
    );
    expect(resolveConversationTitle("Auth Middleware Rewrite", "es")).toBe(
      "Auth Middleware Rewrite",
    );
  });

  test("defaults locale inside the helper", () => {
    expect(
      resolveConversationTitle(MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING),
    ).toBe("Generating title...");
  });
});

describe("isMessageKey", () => {
  test("recognizes catalog keys only", () => {
    expect(isMessageKey(MESSAGE_KEYS.CONVERSATION_TITLE_UNTITLED)).toBe(true);
    expect(isMessageKey("Untitled Conversation")).toBe(false);
    expect(isMessageKey("Untitled")).toBe(false);
  });
});
