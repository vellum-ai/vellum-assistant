/**
 * Test preload — registers happy-dom globals (window, document,
 * localStorage, sessionStorage, etc.) so component and hook tests
 * can run in Bun's test runner without a real browser.
 *
 * Loaded via `preload` in bunfig.toml.
 *
 * Reference: https://github.com/nicedoc/happy-dom/wiki/GlobalRegistrator
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Tests default to platform mode (matching CI/CD builds). Individual tests
// that need local mode should mock isLocalMode() instead.
process.env.VITE_PLATFORM_MODE = "true";

// Set a base URL so relative fetch requests (e.g. "/v1/assistants/...")
// resolve correctly instead of failing against "about:blank".
window.location.href = "http://localhost:3000";
