/**
 * Where translation catalogs live, and how they reach the running app.
 *
 * Catalogs are **source files under `src/i18n/locales/<locale>/<ns>.json`**,
 * not runtime-fetched assets. Each is pulled in with a dynamic `import()`, so
 * Vite emits one chunk per locale and the app downloads exactly the locale it
 * renders — but every chunk is part of the build output, sitting next to the
 * JS on disk.
 *
 * That last property is why this is not `i18next-http-backend` (the usual
 * default, which GETs `/locales/{lng}/{ns}.json` from `public/`):
 *
 * - **Capacitor** serves the bundle from `capacitor://localhost` and the app
 *   is expected to work offline. An HTTP fetch for UI copy makes first paint
 *   depend on the network and fails outright on a cold offline launch.
 * - **Electron** loads the renderer from a local file/custom scheme where the
 *   same fetch is at best a different origin to get right, at worst blocked.
 * - Bundled chunks are cache-busted by the build hash. A catalog in `public/`
 *   is served unhashed and can be held by a stale HTTP cache after a deploy,
 *   so users see last release's copy against this release's UI.
 *
 * The registry below is written out by hand rather than generated with
 * `import.meta.glob`. Two reasons: it is typed as
 * `Record<SupportedLocale, CatalogLoader>`, so adding a locale to
 * `SUPPORTED_LOCALES` without adding its catalog is a compile error instead of
 * a runtime miss; and `import.meta.glob` is a Vite-only transform that does
 * not exist under Bun's test runner, which would force every test touching
 * i18n through a mock. Revisit if the locale count makes the registry tedious.
 *
 * Reference: https://vite.dev/guide/features#dynamic-import
 */
import type { SupportedLocale } from "@/i18n/supported-locales";

/** The single namespace shipped today. Split by domain when catalogs grow. */
export const DEFAULT_NAMESPACE = "common";

/**
 * A parsed catalog. Values are ICU MessageFormat strings; nesting mirrors the
 * dotted key path used at the call site (`t("notFound.title")`).
 */
export type Catalog = Record<string, unknown>;

type CatalogLoader = () => Promise<{ default: Catalog }>;

const CATALOG_LOADERS: Record<SupportedLocale, CatalogLoader> = {
  en: () => import("@/i18n/locales/en/common.json"),
  es: () => import("@/i18n/locales/es/common.json"),
};

/** Load one locale's catalog for the default namespace. */
export async function loadCatalog(locale: SupportedLocale): Promise<Catalog> {
  const module = await CATALOG_LOADERS[locale]();
  return module.default;
}

/**
 * Every locale that has a loader. Exported for the coverage test that asserts
 * this registry and `SUPPORTED_LOCALES` stay in lockstep.
 */
export function loadableLocales(): SupportedLocale[] {
  return Object.keys(CATALOG_LOADERS) as SupportedLocale[];
}
