/**
 * Boot resilience when a locale's catalog chunk cannot be fetched.
 *
 * Lives in its own file because it mocks `@/i18n/catalogs` for the whole
 * module registry, and `i18next` is a process-wide singleton: an instance
 * initialized here would leak into any other suite in the same process.
 * `scripts/run-tests.ts` gives every file its own process.
 */
import { describe, expect, mock, test } from "bun:test";

import englishChat from "@/i18n/locales/en/chat.json";
import englishCommon from "@/i18n/locales/en/common.json";

const englishCatalogs = { common: englishCommon, chat: englishChat };

const captureError = mock(
  (_error: unknown, _opts: Record<string, unknown>) => undefined,
);
const loadCatalogs = mock(async (_locale: string) => englishCatalogs);

mock.module("@/i18n/system-locale", () => ({ systemLocales: () => ["es"] }));
mock.module("@/lib/sentry/capture-error", () => ({ captureError }));
mock.module("@/i18n/catalogs", () => ({
  FALLBACK_CATALOGS: englishCatalogs,
  loadCatalogs,
}));

const { initI18n } = await import("@/i18n/i18n");
const { t } = await import("i18next");

describe("initI18n when a catalog chunk is unreachable", () => {
  test("degrades to English and reports, rather than rejecting", async () => {
    // A rejected chunk import is what an offline launch, or an entry bundle
    // outliving the assets a deploy removed, actually looks like. This
    // rejection reaching `boot()` ahead of `createRoot()` would leave a blank
    // screen, so it must not escape.
    // `mockImplementationOnce` rather than `mockRejectedValueOnce`: the latter
    // builds the rejected promise when the mock is configured, which Bun sees
    // as an unhandled rejection before `initI18n` ever awaits it.
    loadCatalogs.mockImplementationOnce(async () => {
      throw new Error("Failed to fetch dynamically imported module");
    });

    const locale = await initI18n();

    expect(locale).toBe("en");
    // Readable copy, not a raw key path.
    expect(t("notFound.title")).toBe("Page not found");

    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0]?.[1]).toMatchObject({
      context: "i18n_catalog_load",
      tags: { locale: "es" },
    });
  });
});
