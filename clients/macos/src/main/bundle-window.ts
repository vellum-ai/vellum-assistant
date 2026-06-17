/**
 * Sandboxed renderer window for `.vellum` bundles.
 *
 * Each bundle gets its own `BrowserWindow` backed by a dedicated
 * `persist:bundle-{uuid}` session partition — cookies, localStorage, and
 * cache are isolated per bundle. The window intentionally omits the main
 * preload script so there is no `window.vellum` bridge; the renderer runs
 * in full sandbox mode with only the web-platform APIs available.
 *
 * Navigation is restricted to the bundle's own `vellumapp://{uuid}/`
 * origin, and `window.open` is blocked outright, so a bundle cannot
 * reach another bundle's content or escape into arbitrary web pages.
 */
import { BrowserWindow, app, session } from "electron";
import path from "node:path";

import { BUNDLES_DIR_NAME, VELLUMAPP_PROTOCOL } from "./app-config";
import { createVellumAppHandler } from "./vellumapp-protocol";
import { denyAllPermissions } from "./permissions";
import { hardenedWebPreferences } from "./windows";

const openBundleWindows = new Map<string, BrowserWindow>();

export const openBundleWindow = (
  uuid: string,
  entry: string,
  name: string,
): BrowserWindow => {
  const existing = openBundleWindows.get(uuid);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const bundleSession = session.fromPartition(`persist:bundle-${uuid}`, {
    cache: true,
  });
  denyAllPermissions(bundleSession);

  const bundlesRoot = path.join(app.getPath("userData"), BUNDLES_DIR_NAME);
  bundleSession.protocol.handle(
    VELLUMAPP_PROTOCOL,
    createVellumAppHandler(bundlesRoot),
  );

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    title: name,
    webPreferences: {
      ...hardenedWebPreferences(),
      session: bundleSession,
      preload: undefined,
    },
  });

  const allowedPrefix = `${VELLUMAPP_PROTOCOL}://${uuid}/`;

  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(allowedPrefix)) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  void win.loadURL(`${VELLUMAPP_PROTOCOL}://${uuid}/${entry}`);

  openBundleWindows.set(uuid, win);
  win.on("closed", () => {
    openBundleWindows.delete(uuid);
  });

  return win;
};

export const closeBundleWindow = (uuid: string): void => {
  const win = openBundleWindows.get(uuid);
  if (win && !win.isDestroyed()) {
    win.close();
  }
  openBundleWindows.delete(uuid);
};

export const getOpenBundleWindows = (): string[] => [
  ...openBundleWindows.keys(),
];
