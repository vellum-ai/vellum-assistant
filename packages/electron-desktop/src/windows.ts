import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
  type WebPreferences,
} from "electron";
import path from "node:path";

import {
  type CookieJar,
  createAuthPopupSignInTracker,
} from "@vellumai/electron-utils/auth-popup-session";

import { areChromeDevToolsEnabled } from "./devtools";

const preloadPath = (): string => path.join(__dirname, "../preload/index.js");

/**
 * The hardened `webPreferences` baseline every Vellum window - and every child
 * popup spawned from one - must carry. Defined exactly once so the security
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
 *   legitimately navigates away from its initial route.
 * - `{ installGuard }` delegates to a caller-supplied guard for windows that
 *   need a bespoke policy. `window.open` is governed by the global
 *   `web-contents-created` handler in `index.ts`.
 */
export type WindowNavigation =
  | "deny-all"
  | { installGuard: (win: BrowserWindow) => void };

export interface CreateWindowOptions {
  /** Window construction options except `webPreferences`, which this seam owns. */
  browserWindow: Omit<BrowserWindowConstructorOptions, "webPreferences">;
  navigation: WindowNavigation;
  /** Disable Chromium timer throttling for windows that host live sessions. */
  backgroundThrottling?: boolean;
}

const applyDenyAllNavigation = (win: BrowserWindow): void => {
  // Outbound links route through explicit IPC. The window itself never leaves
  // its initial route or carries the preload bridge into another destination.
  win.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
};

/** Create a BrowserWindow with the shared security and navigation baseline. */
export const createWindow = (opts: CreateWindowOptions): BrowserWindow => {
  const win = new BrowserWindow({
    ...opts.browserWindow,
    webPreferences: {
      preload: preloadPath(),
      ...hardenedWebPreferences(),
      ...(opts.backgroundThrottling === undefined
        ? {}
        : { backgroundThrottling: opts.backgroundThrottling }),
    },
  });

  if (opts.navigation === "deny-all") {
    applyDenyAllNavigation(win);
  } else {
    opts.navigation.installGuard(win);
  }

  return win;
};

export interface WebContentsSecurityOptions {
  cookies: () => CookieJar;
  logger: Pick<Console, "error" | "info" | "warn">;
  openExternal: (url: string) => void | Promise<void>;
}

export const installWebContentsSecurity = (
  contents: WebContents,
  options: WebContentsSecurityOptions,
): void => {
  contents.on("console-message", (event) => {
    if (event.level === "debug") {
      return;
    }
    const line = `[renderer wc=${contents.id}] ${event.message}`;
    if (event.level === "error") {
      options.logger.error(line);
    } else if (event.level === "warning") {
      options.logger.warn(line);
    } else {
      options.logger.info(line);
    }
  });

  const authPopups = createAuthPopupSignInTracker({
    cookies: options.cookies,
    onCleared: (hosts, removed) =>
      options.logger.info(
        `[auth-popup] cleared ${removed} sign-in cookie(s) for ${hosts.join(", ")}`,
      ),
    onError: (err) =>
      options.logger.warn("[auth-popup] failed to clear sign-in cookies:", err),
  });

  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === "new-window" && url === "about:blank") {
      authPopups.markNextChildAsAuthPopup();
      return allowPreloadFreePopup();
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { action: "deny" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { action: "deny" };
    }
    if (disposition === "new-window") {
      return allowPreloadFreePopup();
    }

    void options.openExternal(url);
    return { action: "deny" };
  });

  contents.on("did-create-window", (window) => {
    authPopups.trackCreatedChild(window);
  });
};

const allowPreloadFreePopup = () => ({
  action: "allow" as const,
  overrideBrowserWindowOptions: {
    webPreferences: {
      ...hardenedWebPreferences(),
      preload: undefined,
    },
  },
});
