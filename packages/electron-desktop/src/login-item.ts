import { app } from "electron";
import { z } from "zod";

import { capabilityToken } from "./capability-registry";
import type { IpcHandle } from "./ipc";

export interface LaunchAtLoginStore {
  read: () => boolean | null;
  subscribe: (listener: () => void) => () => void;
  write: (enabled: boolean) => void;
}

export interface LoginItemRuntime {
  handle: IpcHandle;
  store?: LaunchAtLoginStore;
}

export interface StartupRegistration {
  settingsPage: "startup-apps";
}

export const STARTUP_REGISTRATION = capabilityToken<StartupRegistration>(
  "desktop.startup-registration",
);

let runtime: LoginItemRuntime | null = null;
let teardown: (() => void) | null = null;

export const configureLoginItem = (next: LoginItemRuntime): void => {
  runtime = next;
};

const requireRuntime = (): LoginItemRuntime => {
  if (!runtime) {
    throw new Error("Login-item runtime is unavailable");
  }
  return runtime;
};

const readLaunchAtLogin = (): boolean => {
  const stored = runtime?.store?.read();
  return stored ?? app.getLoginItemSettings().openAtLogin;
};

const writeLaunchAtLogin = (enabled: boolean): void => {
  const store = runtime?.store;
  if (store) {
    store.write(enabled);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
};

const syncLoginItem = (): void => {
  app.setLoginItemSettings({ openAtLogin: readLaunchAtLogin() });
};

export const installLoginItemIpc = (): void => {
  const { handle } = requireRuntime();
  handle("vellum:launchAtLogin:get", z.tuple([]), readLaunchAtLogin);
  handle("vellum:launchAtLogin:set", z.tuple([z.boolean()]), ([enabled]) => {
    writeLaunchAtLogin(enabled);
  });
};

export const installLoginItem = (): void => {
  const { store } = requireRuntime();
  if (!store || teardown) {
    return;
  }
  if (store.read() === null) {
    store.write(app.getLoginItemSettings().openAtLogin);
  }
  syncLoginItem();
  teardown = store.subscribe(syncLoginItem);
};

export const __resetLoginItemForTesting = (): void => {
  teardown?.();
  teardown = null;
  runtime = null;
};
