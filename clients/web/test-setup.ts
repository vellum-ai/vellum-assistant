/**
 * Test preload — registers happy-dom globals (window, document,
 * localStorage, sessionStorage, etc.) so component and hook tests
 * can run in Bun's test runner without a real browser.
 *
 * Loaded via `preload` in bunfig.toml.
 *
 * Reference: https://github.com/nicedoc/happy-dom/wiki/GlobalRegistrator
 */

import { plugin, type BunPlugin } from "bun";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";

import { i18nextInitOptions } from "./src/i18n/config";
import englishCatalog from "./src/i18n/locales/en/common.json";

GlobalRegistrator.register();

// Vite asset-URL query suffixes (`?worker&url`, `?url`, `?worker`) aren't
// understood by Bun's resolver. Production builds rely on Vite to turn these
// imports into emitted-asset URLs (e.g. the live-voice AudioWorklet); in tests
// we only need the import to resolve, so map any such specifier to a stub
// default export (the URL string). Tests that exercise the asset drive it
// through their own mocks rather than fetching the real URL.
const viteAssetUrlStub: BunPlugin = {
  name: "vite-asset-url-stub",
  setup(build) {
    build.onLoad({ filter: /\?(worker&url|url|worker)$/ }, (args) => ({
      contents: `export default ${JSON.stringify(args.path)};`,
      loader: "js",
    }));
  },
};

plugin(viteAssetUrlStub);

// Tests default to platform mode (matching CI/CD builds). Individual tests
// that need local mode should mock isLocalClient() instead.
process.env.VITE_PLATFORM_MODE = "true";

// Set a base URL so relative fetch requests (e.g. "/v1/assistants/...")
// resolve correctly instead of failing against "about:blank".
window.location.href = "http://localhost:3000";

// Components read their copy through `t()`, so i18next must be initialized
// before any test mounts one — an uninitialized instance returns the raw key
// path ("notFound.title"), and every assertion on user-visible text fails.
//
// Pinned to English rather than routed through `initI18n()`: tests assert
// against the source copy, and the host's reported locale must not decide
// whether they pass. `initI18n()` is exercised directly by `i18n.test.ts`,
// which mocks the locale sources it reads.
//
// Only `@/i18n/config` and the English catalog are imported here. Pulling in
// `@/i18n/i18n` would seed the module registry with `system-locale` and
// `device-settings` before the tests that mock them get to run.
await i18next
  .use(new ICU())
  .use(initReactI18next)
  .init(i18nextInitOptions("en", { en: englishCatalog }));
