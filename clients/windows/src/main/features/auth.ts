import { app, session, shell } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  configureNativeAuth,
  installNativeAuth,
} from "@vellumai/electron-desktop/native-auth";
import {
  clearSessionToken,
  getSessionToken,
  saveSessionToken,
  setSessionTokenLogger,
} from "@vellumai/electron-desktop/session-token-store";
import { resolveLocalConfigFromEnv } from "@vellumai/local-mode";

import { handle, handleSync } from "../ipc.client";
import log from "../logger";
import { ensureVisible } from "../main-window";

const authFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "native-auth",
  install: () => {
    setSessionTokenLogger(log);
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
    installNativeAuth();
  },
};

export default authFeature;
