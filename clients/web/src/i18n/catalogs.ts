/**
 * Where translation catalogs live, and how they reach the running app.
 *
 * Catalogs are source files under `src/i18n/locales/<locale>/<ns>.json`, not
 * runtime-fetched assets.
 *
 * English is imported statically, so it is part of the entry chunk and is
 * readable with no network round trip at all. Every other locale is pulled in
 * with a dynamic `import()`, so Vite emits one chunk per locale and the app
 * downloads only the locale it renders. The asymmetry is deliberate: the
 * fallback catalog is what the UI falls back *to*, so it must be the one thing
 * that cannot fail to load.
 *
 * Non-default locales are still bundled output sitting next to the JS, which
 * is why this is not `i18next-http-backend` (the usual default, which GETs
 * `/locales/{lng}/{ns}.json` from `public/`):
 *
 * - Capacitor serves the bundle from `capacitor://localhost` and the app is
 *   expected to work offline. An HTTP fetch for UI copy makes first paint
 *   depend on the network and fails outright on a cold offline launch.
 * - Electron loads the renderer from a local file/custom scheme where the same
 *   fetch is at best a different origin to get right, at worst blocked.
 * - Bundled chunks are cache-busted by the build hash. A catalog in `public/`
 *   is served unhashed and can be held by a stale HTTP cache after a deploy,
 *   so users see one release's copy against another release's UI.
 *
 * The registry below is written out by hand rather than generated with
 * `import.meta.glob`. Two reasons: it is typed as a total map over the
 * non-default locales, so adding a locale to `SUPPORTED_LOCALES` without
 * adding its catalog is a compile error instead of a runtime miss; and
 * `import.meta.glob` is a Vite-only transform absent under Bun's test runner,
 * which would force every test touching i18n through a mock. Revisit if the
 * locale count makes the registry tedious.
 *
 * Reference: https://vite.dev/guide/features#dynamic-import
 */
import enCommon from "@/i18n/locales/en/common.json";
import { DEFAULT_LOCALE, type SupportedLocale } from "@/i18n/supported-locales";

/** The single namespace shipped today. Split by domain when catalogs grow. */
export const DEFAULT_NAMESPACE = "common";

/**
 * A parsed catalog. Values are ICU MessageFormat strings; nesting mirrors the
 * dotted key path used at the call site (`t("notFound.title")`).
 */
export type Catalog = Record<string, unknown>;

type CatalogLoader = () => Promise<{ default: Catalog }>;

/**
 * The English catalog, available synchronously. Both the boot path and the
 * test preload seed i18next with this, so a missing or unreachable chunk for
 * any other locale degrades to readable English rather than raw key paths.
 */
export const FALLBACK_CATALOG: Catalog = enCommon;

/** Loaders for the locales that are not bundled into the entry chunk. */
const CATALOG_LOADERS: Record<
  Exclude<SupportedLocale, typeof DEFAULT_LOCALE>,
  CatalogLoader
> = {
  es: () => import("@/i18n/locales/es/common.json"),
};

/**
 * Load one locale's catalog for the default namespace.
 *
 * Rejects when a non-default locale's chunk cannot be fetched (offline, or an
 * entry bundle outliving the assets a deploy removed). Callers on the boot
 * path treat that as "stay on {@link FALLBACK_CATALOG}".
 */
export async function loadCatalog(locale: SupportedLocale): Promise<Catalog> {
  if (locale === DEFAULT_LOCALE) {
    return FALLBACK_CATALOG;
  }
  const module = await CATALOG_LOADERS[locale]();
  return module.default;
}

/**
 * Every locale this module can produce a catalog for. Exported for the
 * coverage test that asserts this stays in lockstep with `SUPPORTED_LOCALES`.
 */
export function loadableLocales(): SupportedLocale[] {
  return [
    DEFAULT_LOCALE,
    ...(Object.keys(CATALOG_LOADERS) as SupportedLocale[]),
  ];
}
