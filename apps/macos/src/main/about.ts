import { BrowserWindow, app, shell } from "electron";
import path from "node:path";
import { z } from "zod";

import { RENDERER_BASE_PROD, getDevRendererBase } from "./app-config";
import { handle } from "./ipc";

/**
 * Branded About window — replaces Electron's default `aboutPanel`
 * (which only shows the bundle name) with the same information surface
 * Swift Vellum exposes today: app name, version, commit SHA, copyright,
 * link to the website.
 *
 * The UI itself is a React route in `apps/web` — `/assistant/about` —
 * loaded into a BrowserWindow by this module. Putting the UI in
 * `apps/web` keeps it inside the design system, lets it iterate
 * alongside the rest of the app, and stays in the dev contributor's
 * mental model that "UI lives in apps/web." Future auxiliary windows
 * (thread pop-outs, command palette, etc.) follow this same pattern;
 * this module is the working example.
 *
 * Version + commit SHA + copyright still flow from the host: the
 * renderer asks for them via `window.vellum.app.versionInfo()`, and
 * the IPC handler installed here returns them. `app.setAboutPanelOptions`
 * is also seeded so the native panel — which AppleScript and other
 * tooling can still invoke independently of our menu — carries the
 * right metadata.
 */

const APP_NAME = "Vellum";
const WEBSITE = "https://vellum.ai";

// Injected by `electron.vite.config.ts` at build time. Resolves to a
// short SHA in CI / dev checkouts, or "unknown" if neither
// `GITHUB_SHA` nor a git tree is available.
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

// The renderer route the About window loads. Mirrors `routes.about` in
// `apps/web/src/utils/routes.ts`; the literal is duplicated rather than
// imported because `apps/macos` and `apps/web` are separate TS projects.
// Drift surfaces as the About window loading the app's catch-all
// NotFound page.
const ABOUT_PATH = "/about";

const aboutWindowUrl = (): string => {
  const base = app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase();
  return `${base}${ABOUT_PATH}`;
};

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
  // → `shell.openExternal` in main. Block every other path so the
  // preload-exposed `window.vellum` surface can't be carried into a
  // destination we don't control: bare-`<a>` href fallbacks, dropped
  // URLs or files onto the window, `window.location` writes from
  // future renderer code, etc.
  aboutWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  aboutWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  void aboutWindow.loadURL(aboutWindowUrl());
};

let installed = false;
export const installAbout = (): void => {
  if (installed) return;
  installed = true;

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

  handle("vellum:app:versionInfo", z.tuple([]), () => getVersionInfo());

  // The renderer is sandboxed — `shell.openExternal` only works from
  // main. The About page's website-link click handler routes through
  // this IPC so the URL opens in the user's default browser instead
  // of navigating the About window away from its route. The target is
  // a fixed constant, never a renderer-supplied URL, so there's no
  // open-redirect surface here.
  handle("vellum:app:openWebsite", z.tuple([]), () =>
    shell.openExternal(WEBSITE),
  );
};
