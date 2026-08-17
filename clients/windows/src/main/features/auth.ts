import { app, session, shell, type Event } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { resolveAuthCallbackScheme } from "@vellumai/electron-desktop/deep-links";
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
import {
  resolveEnvironmentName,
  resolveLocalConfigFromEnv,
} from "@vellumai/local-mode";

import { startWindowsAuthCallback } from "../auth-callback";
import { handle, handleSync } from "../ipc.client";
import log from "../logger";
import { ensureVisible } from "../main-window";

const subscribeToAuthCallback = (
  listener: (url: string) => void,
): (() => void) => {
  const onSecondInstance = (_event: Event, argv: string[]): void => {
    for (const arg of argv) {
      listener(arg);
    }
  };
  const onOpenUrl = (event: Event, url: string): void => {
    event.preventDefault();
    listener(url);
  };

  app.on("second-instance", onSecondInstance);
  app.on("open-url", onOpenUrl);
  return () => {
    app.off("second-instance", onSecondInstance);
    app.off("open-url", onOpenUrl);
  };
};

const authFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "native-auth",
  install: () => {
    const authScheme = resolveAuthCallbackScheme(
      resolveEnvironmentName(process.env),
    );
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
      ...(app.isPackaged
        ? {
            startCallback: (expectedState: string) =>
              startWindowsAuthCallback(expectedState, {
                scheme: authScheme,
                subscribe: subscribeToAuthCallback,
              }),
          }
        : {}),
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
