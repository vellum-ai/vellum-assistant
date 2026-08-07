/**
 * i18next configuration and lifecycle for the web SPA.
 *
 * Three decisions worth knowing before changing anything here:
 *
 * **ICU MessageFormat is the on-disk format.** i18next's native plural syntax
 * (`key_one` / `key_other` sibling keys) is i18next-specific; ICU
 * MessageFormat is what Crowdin, Lokalise, Phrase, Tolgee, Android and iOS all
 * read. Authoring in ICU means the catalogs outlive this library choice and
 * can be handed to any TMS as-is. `i18next-icu` swaps i18next's formatter for
 * `intl-messageformat`, which resolves plural categories through the platform
 * `Intl.PluralRules`, so a locale with six plural forms gets six without the
 * call site knowing anything about it.
 *
 * **Initialization is awaited before first render.** `initI18n()` runs in
 * `main.tsx` ahead of `createRoot`, so components never observe an
 * uninitialized i18next and no raw key path is painted. English costs nothing
 * to reach; any other locale costs one dynamic import of a small JSON chunk.
 *
 * **Locale resolution has a fixed precedence**, applied by
 * {@link resolveInitialLocale}:
 *   1. the explicit in-app preference (`device:locale`), if it is still a
 *      supported locale (a user's stated choice outranks any host signal);
 *   2. the host's preferred languages (see `system-locale.ts`);
 *   3. `DEFAULT_LOCALE`.
 *
 * References:
 * - https://www.i18next.com/overview/configuration-options
 * - https://github.com/i18next/i18next-icu
 * - https://unicode-org.github.io/icu/userguide/format_parse/messages/
 */
import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";

import {
  FALLBACK_CATALOGS,
  loadCatalogs,
  type LocaleCatalogs,
} from "@/i18n/catalogs";
import { i18nextInitOptions } from "@/i18n/config";
import { NAMESPACES } from "@/i18n/namespaces";
import { systemLocales } from "@/i18n/system-locale";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  negotiateLocale,
  type SupportedLocale,
} from "@/i18n/supported-locales";
import { captureError } from "@/lib/sentry/capture-error";
import { getDeviceSetting, setDeviceSetting } from "@/utils/device-settings";

/**
 * The locale to boot with, resolved from the stored preference, then the
 * host, then the default. Pure apart from the storage read, and exported so
 * tests and a future language picker can ask without initializing i18next.
 */
export function resolveInitialLocale(): SupportedLocale {
  const stored = getDeviceSetting("locale", "");
  if (isSupportedLocale(stored)) {
    return stored;
  }
  return negotiateLocale(systemLocales());
}

/**
 * Reflect the active locale onto the document element.
 *
 * `lang` drives the UA's own locale-sensitive behavior: hyphenation, spell
 * check, the voice a screen reader picks, and font fallback for scripts the
 * primary family doesn't cover. It is not decorative: an unset or wrong `lang`
 * makes a screen reader read Spanish copy with English phonemes.
 *
 * `dir` is set from `Intl.Locale`'s text-info rather than a hand-kept RTL list
 * so adding Arabic or Hebrew to `SUPPORTED_LOCALES` needs no change here.
 *
 * References:
 * - https://www.w3.org/International/questions/qa-html-language-declarations
 * - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Locale/getTextInfo
 */
function applyDocumentLocale(locale: SupportedLocale): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = locale;

  // `getTextInfo()` postdates the TS `ES2023` lib target, and engines that
  // predate the method rename still expose the earlier `textInfo` getter, so
  // both shapes are probed behind a cast. LTR is the safe assumption for every
  // locale currently shipped.
  type LocaleTextInfo = Intl.Locale & {
    getTextInfo?: () => { direction?: string };
    textInfo?: { direction?: string };
  };

  let direction: string | undefined;
  try {
    const resolved = new Intl.Locale(locale) as LocaleTextInfo;
    direction =
      resolved.getTextInfo?.().direction ?? resolved.textInfo?.direction;
  } catch {
    direction = undefined;
  }
  document.documentElement.dir = direction === "rtl" ? "rtl" : "ltr";
}

/** Load a locale's catalogs into i18next unless they are already registered. */
async function ensureCatalogs(locale: SupportedLocale): Promise<void> {
  const missing = NAMESPACES.filter(
    (namespace) => !i18next.hasResourceBundle(locale, namespace),
  );
  if (missing.length === 0) {
    return;
  }
  const catalogs = await loadCatalogs(locale);
  for (const namespace of missing) {
    i18next.addResourceBundle(
      locale,
      namespace,
      catalogs[namespace],
      true,
      true,
    );
  }
}

/**
 * Report a catalog that could not be loaded.
 *
 * A chunk fetch fails when the device is offline, or when a still-cached entry
 * bundle asks for an asset a later deploy removed. Neither is actionable at
 * the call site beyond staying on the locale already rendering, so it is a
 * warning rather than an error.
 */
function reportCatalogFailure(error: unknown, locale: SupportedLocale): void {
  captureError(error, {
    context: "i18n_catalog_load",
    level: "warning",
    tags: { locale },
  });
}

/**
 * Initialize i18next for the resolved locale. Safe to call more than once:
 * a repeat call re-resolves the locale against the existing instance.
 *
 * Never rejects. This runs on the boot path ahead of `createRoot()`, where an
 * escaping rejection costs the whole app a render, and English is always
 * reachable. Returns the locale actually activated, which is English when the
 * preferred locale's catalog could not be loaded.
 */
export async function initI18n(): Promise<SupportedLocale> {
  const requested = resolveInitialLocale();

  if (i18next.isInitialized) {
    try {
      await changeLocale(requested);
      return requested;
    } catch (error) {
      reportCatalogFailure(error, requested);
      return currentLocale();
    }
  }

  // English is seeded first, from the entry chunk rather than a fetch. It is
  // both the fallback for a key a translated catalog is missing and the floor
  // this function degrades to, so it must be in place before anything that can
  // fail is attempted.
  const resources: Record<string, LocaleCatalogs> = {
    [DEFAULT_LOCALE]: FALLBACK_CATALOGS,
  };
  let locale: SupportedLocale = DEFAULT_LOCALE;

  if (requested !== DEFAULT_LOCALE) {
    try {
      resources[requested] = await loadCatalogs(requested);
      locale = requested;
    } catch (error) {
      reportCatalogFailure(error, requested);
    }
  }

  await i18next
    .use(new ICU())
    .use(initReactI18next)
    .init(i18nextInitOptions(locale, resources));

  applyDocumentLocale(locale);
  return locale;
}

/**
 * Switch the active locale: load its catalog if needed, activate it, persist
 * the choice as a device setting, and update the document element.
 *
 * Persisted with `device:` scope because a language choice describes the
 * device, not the account. It must survive logout so the login screen stays in
 * the language the user picked.
 *
 * Rejects when the catalog cannot be fetched, leaving the previous locale
 * active. Unlike {@link initI18n} this is user-initiated, so the caller is the
 * one that can say something useful about the failure.
 */
export async function changeLocale(locale: SupportedLocale): Promise<void> {
  await ensureCatalogs(locale);
  await i18next.changeLanguage(locale);
  setDeviceSetting("locale", locale);
  applyDocumentLocale(locale);
}

/** The active locale, or `DEFAULT_LOCALE` before initialization. */
export function currentLocale(): SupportedLocale {
  const language = i18next.resolvedLanguage ?? i18next.language;
  return isSupportedLocale(language) ? language : DEFAULT_LOCALE;
}

export { i18next };
