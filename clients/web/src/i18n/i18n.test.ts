import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let preferred: string[] = [];
mock.module("@/i18n/system-locale", () => ({
  systemLocales: () => preferred,
}));

const { changeLocale, currentLocale, initI18n, resolveInitialLocale } =
  await import("@/i18n/i18n");
const { t } = await import("i18next");
const { deviceKey } = await import("@/utils/device-settings");

const LOCALE_KEY = deviceKey("locale");

beforeEach(() => {
  preferred = [];
  localStorage.removeItem(LOCALE_KEY);
});

afterEach(() => {
  localStorage.removeItem(LOCALE_KEY);
});

describe("resolveInitialLocale", () => {
  test("prefers the stored device setting over the host", () => {
    localStorage.setItem(LOCALE_KEY, "es");
    preferred = ["en-US"];
    expect(resolveInitialLocale()).toBe("es");
  });

  test("falls back to the host preference when nothing is stored", () => {
    preferred = ["es-MX", "en"];
    expect(resolveInitialLocale()).toBe("es");
  });

  test("ignores a stored locale that is no longer shipped", () => {
    // A locale can be withdrawn between releases; a stale preference must not
    // strand the user on a catalog that no longer exists.
    localStorage.setItem(LOCALE_KEY, "fr");
    preferred = ["es"];
    expect(resolveInitialLocale()).toBe("es");
  });

  test("falls back to English when the host offers nothing supported", () => {
    preferred = ["fr-CA"];
    expect(resolveInitialLocale()).toBe("en");
  });
});

describe("initI18n", () => {
  test("boots the host-preferred locale and renders its catalog", async () => {
    preferred = ["es"];
    expect(await initI18n()).toBe("es");
    expect(currentLocale()).toBe("es");
    expect(t("notFound.title")).toBe("Página no encontrada");
  });

  test("reflects the locale onto the document element", async () => {
    preferred = ["es"];
    await initI18n();
    expect(document.documentElement.lang).toBe("es");
    expect(document.documentElement.dir).toBe("ltr");
  });
});

describe("changeLocale", () => {
  test("switches catalogs and persists the choice", async () => {
    await initI18n();
    await changeLocale("es");

    expect(currentLocale()).toBe("es");
    expect(t("notFound.title")).toBe("Página no encontrada");
    expect(localStorage.getItem(LOCALE_KEY)).toBe("es");
    expect(document.documentElement.lang).toBe("es");

    await changeLocale("en");
    expect(t("notFound.title")).toBe("Page not found");
    expect(localStorage.getItem(LOCALE_KEY)).toBe("en");
  });
});

describe("ICU message formatting", () => {
  beforeEach(async () => {
    await initI18n();
    await changeLocale("en");
  });

  test("selects the singular plural category", () => {
    expect(t("chat:conversationAssets.label", { count: 1 })).toBe("1 asset");
    expect(t("chat:conversationAssets.ariaLabel", { count: 1 })).toBe(
      "Conversation assets, 1 item",
    );
    expect(t("chat:conversationAssets.ariaLabelUnseen", { count: 1 })).toBe(
      "Conversation assets, 1 item (unseen changes)",
    );
  });

  test("selects the plural category for other counts", () => {
    expect(t("chat:conversationAssets.label", { count: 0 })).toBe("0 assets");
    expect(t("chat:conversationAssets.label", { count: 7 })).toBe("7 assets");
  });

  test("pluralizes in the active locale after a switch", async () => {
    await changeLocale("es");
    expect(t("chat:conversationAssets.label", { count: 1 })).toBe("1 recurso");
    expect(t("chat:conversationAssets.label", { count: 7 })).toBe("7 recursos");
  });

  test("renders Russian copy and CLDR plural categories", async () => {
    await changeLocale("ru");
    expect(t("notFound.title")).toBe("Страница не найдена");
    expect(t("chat:conversationAssets.label", { count: 1 })).toBe("1 ресурс");
    expect(t("chat:conversationAssets.label", { count: 2 })).toBe("2 ресурса");
    expect(t("chat:conversationAssets.label", { count: 5 })).toBe("5 ресурсов");
    expect(t("chat:conversationAssets.label", { count: 21 })).toBe(
      "21 ресурс",
    );
    expect(t("chat:conversationAssets.label", { count: 22 })).toBe(
      "22 ресурса",
    );
  });

  test("renders a bare apostrophe literally", () => {
    // ICU treats `'` as an escape character, but only when it precedes a
    // syntax character. English copy is full of contractions, so this is the
    // difference between shipping "you're" and shipping "youre looking".
    expect(t("notFound.body")).toBe(
      "The page you're looking for doesn't exist or may have moved.",
    );
  });
});
