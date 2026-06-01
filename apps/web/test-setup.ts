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
// that need local mode should mock isLocalMode() instead.
process.env.VITE_PLATFORM_MODE = "true";

// Set a base URL so relative fetch requests (e.g. "/v1/assistants/...")
// resolve correctly instead of failing against "about:blank".
window.location.href = "http://localhost:3000";
