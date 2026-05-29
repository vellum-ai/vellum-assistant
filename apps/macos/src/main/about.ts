import { BrowserWindow, app, ipcMain, shell } from "electron";
import path from "node:path";

import aboutHtml from "./about.html?raw";

/**
 * Branded About window — replaces Electron's default `aboutPanel`
 * (which only shows the bundle name) with the same information surface
 * Swift Vellum exposes today: app name, version, commit SHA, copyright,
 * link to the website.
 *
 * The HTML lives in `about.html` and is imported via Vite's `?raw`
 * suffix as a string, then loaded into the BrowserWindow as a `data:`
 * URL. That keeps the asset bundling story trivial (no `extraResources`
 * copy step, no file-path resolution that drifts between dev and
 * packaged builds) at the cost of a small `'unsafe-inline'` CSP for the
 * single inline `<script>` that pulls version info from
 * `window.vellum.app.*`. The window is sandboxed with
 * `contextIsolation: true` and `nodeIntegration: false`, so the inline
 * script can only reach the preload bridge — same security posture as
 * the main BrowserWindow.
 *
 * `app.setAboutPanelOptions()` is still called at install time so the
 * native panel — which AppleScript / accessibility tooling can still
 * invoke independently of our menu — carries the right metadata.
 */

const APP_NAME = "Vellum";
const WEBSITE = "https://vellum.ai";

// Injected by `electron.vite.config.ts` at build time. `unknown` resolves
// to a 7-char SHA, the literal "dev" off a git checkout, or "unknown" if
// neither GITHUB_SHA nor a git tree is available.
declare const __VELLUM_BUILD_SHA__: string;

const COMMIT_SHA: string =
  typeof __VELLUM_BUILD_SHA__ === "string" ? __VELLUM_BUILD_SHA__ : "unknown";

const COPYRIGHT = (): string => `© ${new Date().getFullYear()} ${APP_NAME}`;

export interface AppVersionInfo {
  appName: string;
  version: string;
  commitSha: string;
  copyright: string;
  website: string;
}

export const getVersionInfo = (): AppVersionInfo => ({
  appName: APP_NAME,
  version: app.getVersion(),
  commitSha: COMMIT_SHA,
  copyright: COPYRIGHT(),
  website: WEBSITE,
});

// Module-scope handle so reopening the menu item focuses the existing
// window instead of stacking duplicates. Reset on `closed` so the next
// invocation rebuilds.
let aboutWindow: BrowserWindow | null = null;

export const openAboutWindow = (): void => {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show();
    aboutWindow.focus();
    return;
  }

  aboutWindow = new BrowserWindow({
    width: 360,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // `hiddenInset` keeps the macOS traffic-light buttons but removes
    // the title bar's chrome — same effect as Swift's
    // `titlebarAppearsTransparent = true`.
    titleBarStyle: "hiddenInset",
    title: `About ${APP_NAME}`,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  aboutWindow.once("ready-to-show", () => {
    aboutWindow?.show();
  });

  aboutWindow.on("closed", () => {
    aboutWindow = null;
  });

  // The About window has no legitimate top-level navigations — its
  // only outbound link routes through `window.vellum.app.openWebsite()`
  // (which uses `shell.openExternal` in main). Block every other
  // navigation path so the preload-exposed `window.vellum` surface
  // can't be carried into a destination we don't control: bare-`<a>`
  // fallbacks if the script handler fails to attach, dropped URLs or
  // files onto the window, `window.location` writes from a future
  // script, etc.
  aboutWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  aboutWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  void aboutWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(aboutHtml)}`,
  );
};

let installed = false;
export const installAbout = (): void => {
  if (installed) return;
  installed = true;

  // Populate the native About panel so AppleScript and accessibility
  // tooling reading the bundle metadata get the right values, even
  // though our menu item routes to the branded window instead.
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    // The native panel renders `version` after an em-dash. Using the
    // commit SHA here matches what Sparkle / Swift Vellum's About
    // window shows.
    version: COMMIT_SHA,
    copyright: COPYRIGHT(),
    website: WEBSITE,
  });

  ipcMain.handle("vellum:app:versionInfo", () => getVersionInfo());

  // The renderer is sandboxed — `shell.openExternal` only works from
  // main. The About window's website-link click handler routes through
  // this IPC so the URL opens in the user's default browser instead of
  // navigating the About window away from the HTML it just loaded.
  ipcMain.handle("vellum:app:openWebsite", () => shell.openExternal(WEBSITE));
};
