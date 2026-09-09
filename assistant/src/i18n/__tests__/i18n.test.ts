import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LOCALE,
  MESSAGE_CATALOGS,
  MESSAGE_KEYS,
  SUPPORTED_LOCALES,
  classifyConversationTitle,
  localeFromAcceptLanguage,
  messageKeyFromStored,
  negotiateLocale,
  resolveConversationTitle,
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

describe("messageKeyFromStored", () => {
  test("recognizes keys and legacy English aliases", () => {
    expect(
      messageKeyFromStored(MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING),
    ).toBe(MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING);
    expect(messageKeyFromStored("Generating title...")).toBe(
      MESSAGE_KEYS.CONVERSATION_TITLE_GENERATING,
    );
    expect(messageKeyFromStored("Untitled Conversation")).toBe(
      MESSAGE_KEYS.CONVERSATION_TITLE_UNTITLED,
    );
    expect(messageKeyFromStored("Untitled")).toBe(
      MESSAGE_KEYS.CONVERSATION_TITLE_UNTITLED,
    );
    expect(messageKeyFromStored("Weekly planning")).toBeNull();
  });
});

describe("classifyConversationTitle / resolveConversationTitle", () => {
  test("empty and untitled aliases are untitled", () => {
    expect(classifyConversationTitle("")).toBe("untitled");
    expect(classifyConversationTitle("Untitled Conversation")).toBe(
      "untitled",
    );
    expect(classifyConversationTitle("Untitled")).toBe("untitled");
    expect(resolveConversationTitle("Untitled Conversation")).toBe(
      "Untitled Conversation",
    );
    expect(resolveConversationTitle(null, "es")).toBe("Sin título");
  });

  test("generating aliases resolve through the catalog", () => {
    expect(classifyConversationTitle("Generating title...")).toBe(
      "generating",
    );
    expect(resolveConversationTitle("Generating title...", "zh")).toBe(
      "标题生成中...",
    );
  });

  test("custom titles pass through", () => {
    expect(classifyConversationTitle("Auth Middleware Rewrite")).toBe(
      "custom",
    );
    expect(resolveConversationTitle("Auth Middleware Rewrite", "es")).toBe(
      "Auth Middleware Rewrite",
    );
  });
});
