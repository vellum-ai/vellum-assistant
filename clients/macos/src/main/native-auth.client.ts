import { app, session, shell } from "electron";

import {
  configureNativeAuth,
  installNativeAuth,
} from "@vellumai/electron-desktop/native-auth";
import { resolveLocalConfigFromEnv } from "@vellumai/local-mode";

import { handle, handleSync } from "./ipc";
import { ensureVisible } from "./main-window";
import {
  clearSessionToken,
  getSessionToken,
  saveSessionToken,
} from "./session-token-store.client";

configureNativeAuth({
  activateWindow: () => {
    app.focus({ steal: true });
    ensureVisible();
  },
  getPlatformUrl: () => resolveLocalConfigFromEnv(process.env).platformUrl,
  ipc: { handle, handleSync },
  openExternal: (url) => shell.openExternal(url),
  removeCookie: (url, name) =>
    session.defaultSession.cookies.remove(url, name),
  sessionStore: {
    clear: clearSessionToken,
    get: getSessionToken,
    save: saveSessionToken,
  },
});

export { installNativeAuth };
