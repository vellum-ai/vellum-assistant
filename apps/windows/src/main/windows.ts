import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebPreferences,
  app,
} from "electron";
import path from "node:path";

import { areChromeDevToolsEnabled } from "./devtools";

const preloadPath = (): string => path.join(__dirname, "../preload/index.js");

/**
 * The hardened `webPreferences` baseline every Vellum window — and every child
 * popup spawned from one — must carry. Defined exactly once so the security
 * posture can't drift between call sites the way hand-rolled
 * `new BrowserWindow(...)` blocks do.
 *
 * - `contextIsolation` + `sandbox` + `nodeIntegration:false` isolate renderer
 *   content from Node and from the preload's privileged scope.
 * - `webSecurity` + `allowRunningInsecureContent:false` keep the same-origin
 *   policy enforced and block mixed (http-in-https) content.
 * - `experimentalFeatures:false` keeps unstable web-platform features off.
 * - `devTools` is enabled only in development and explicit debug packages; a
 *   normal packaged build ships with it disabled so the renderer can't be
 *   inspected on an end user's machine.
 *
 * `preload` is deliberately excluded: it is role-specific (app windows load the
 * Vellum bridge, OAuth popups intentionally run without it), so each caller
 * supplies its own. See Electron's security checklist:
 * https://www.electronjs.org/docs/latest/tutorial/security
 */
export const hardenedWebPreferences = (): WebPreferences => ({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  devTools: areChromeDevToolsEnabled(),
});

/**
 * Top-level navigation policy for a window.
 *
 * - `"deny-all"` blocks every top-level navigation and every `window.open`
 *   from the window. Use for static auxiliary windows whose content never
 *   legitimately navigates away from its initial route (the About window, and
 *   future palette / HUD windows that load a fixed renderer route).
 * - `{ installGuard }` delegates to a caller-supplied guard for windows that
 *   need a bespoke policy — the main window relaxes same-origin rules during
 *   the OAuth sign-in chain. `window.open` for these is governed by the global
 *   `web-contents-created` handler in `index.ts`.
 */
export type WindowNavigation =
  | "deny-all"
  | { installGuard: (win: BrowserWindow) => void };

export interface CreateWindowOptions {
  /**
   * Window construction options *except* `webPreferences`, which the seam owns
   * so every window inherits the same hardened baseline.
   */
  browserWindow: Omit<BrowserWindowConstructorOptions, "webPreferences">;
  navigation: WindowNavigation;
}

const applyDenyAllNavigation = (win: BrowserWindow): void => {
  // The window only ever shows its initial route; any outbound link routes
  // through an explicit IPC → `shell.openExternal`. Blocking top-level
  // navigation and popups keeps the preload-exposed `window.vellum` surface
  // from being carried into a destination we don't control — via a bare
  // `<a href>`, a dropped URL/file, or a `window.location` write.
  win.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
};

/**
 * The single creation path for every BrowserWindow the app opens. Seals the
 * hardened `webPreferences` baseline — no call site can omit a flag — and
 * applies the window's navigation policy. Window-specific lifecycle (sizing,
 * readiness, visibility tracking) stays with each caller, since the main and
 * auxiliary windows legitimately differ there; only the security-critical
 * baseline is centralised.
 */
export const createWindow = (opts: CreateWindowOptions): BrowserWindow => {
  const win = new BrowserWindow({
    ...opts.browserWindow,
    webPreferences: {
      preload: preloadPath(),
      ...hardenedWebPreferences(),
    },
  });

  if (opts.navigation === "deny-all") {
    applyDenyAllNavigation(win);
  } else {
    opts.navigation.installGuard(win);
  }

  return win;
};
