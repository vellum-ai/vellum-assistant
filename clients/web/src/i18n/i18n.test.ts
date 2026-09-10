import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SupportedLocale } from "@/i18n/supported-locales";

let preferred: string[] = [];
mock.module("@/i18n/system-locale", () => ({
  systemLocales: () => preferred,
}));

const {
  changeLocale,
  currentLocale,
  formatLocale,
  initI18n,
  resolveInitialLocale,
} = await import("@/i18n/i18n");
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
    expect(t("chat:conversationAssets.label", { count: 21 })).toBe("21 ресурс");
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

describe("formatLocale", () => {
  async function hostLanguagesUnder(
    hosts: string[],
    app: SupportedLocale,
  ): Promise<string> {
    await initI18n();
    await changeLocale(app);
    preferred = hosts;
    try {
      return formatLocale();
    } finally {
      preferred = [];
      await changeLocale("en");
    }
  }

  test("keeps the host's region when it speaks the app's language", async () => {
    expect(await hostLanguagesUnder(["en-GB"], "en")).toBe("en-GB");
    expect(await hostLanguagesUnder(["es-MX"], "es")).toBe("es-MX");
  });

  test("keeps a Chinese host tag under either Chinese catalog", async () => {
    expect(await hostLanguagesUnder(["zh-TW"], "zh")).toBe("zh-TW");
  });

  test("falls back to the app locale when the host speaks another language", async () => {
    expect(await hostLanguagesUnder(["de-DE"], "en")).toBe("en");
  });

  test("reads past the host's first language to the app's own", async () => {
    // A device that leads with English while the app runs in Spanish still
    // states a Spanish region, and that is the one to format in.
    expect(await hostLanguagesUnder(["en-US", "es-MX"], "es")).toBe("es-MX");
  });

  test("falls back to the app locale for a tag Intl cannot parse", async () => {
    // A POSIX environment reports `C`, some shells report an underscored
    // `en_US`, and a truncated tag reaches the region check intact. Handing
    // any of them to Intl throws RangeError inside a formatter.
    expect(await hostLanguagesUnder(["C"], "en")).toBe("en");
    expect(await hostLanguagesUnder(["en_US"], "en")).toBe("en");
    expect(await hostLanguagesUnder(["en-1"], "en")).toBe("en");
  });

  test("reads past a malformed tag to the next one in the app's language", async () => {
    // The malformed entry leads the list and speaks the app's language, so a
    // search that validated only its own pick would stop there and never
    // reach the region the device actually states.
    expect(await hostLanguagesUnder(["en-1", "en-GB"], "en")).toBe("en-GB");
  });
});
