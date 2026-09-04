import { app } from "electron";
import { z } from "zod";

import { capabilityToken } from "./capability-registry";
import type { IpcHandle } from "./ipc";

export interface LaunchAtLoginStore {
  read: () => boolean | null;
  subscribe: (listener: () => void) => () => void;
  write: (enabled: boolean) => void;
}

/**
 * Platform hook for systems where Electron's login-item API is a no-op.
 * Linux supplies an XDG autostart implementation; macOS and Windows omit it
 * and keep using `app.get/setLoginItemSettings`.
 */
export interface LoginItemBackend {
  read: () => boolean;
  write: (enabled: boolean) => void;
}

export interface LoginItemRuntime {
  backend?: LoginItemBackend;
  handle: IpcHandle;
  identity?: { path: string; args: string[] };
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

/** Current operating-system state, ignoring the persisted setting. */
const readOpenAtLogin = (): boolean => {
  const backend = runtime?.backend;
  return backend
    ? backend.read()
    : app.getLoginItemSettings(runtime?.identity).openAtLogin;
};

const applyOpenAtLogin = (enabled: boolean): void => {
  const backend = runtime?.backend;
  if (backend) {
    backend.write(enabled);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, ...runtime?.identity });
};

const readLaunchAtLogin = (): boolean =>
  runtime?.store?.read() ?? readOpenAtLogin();

const writeLaunchAtLogin = (enabled: boolean): void => {
  const store = runtime?.store;
  if (store) {
    store.write(enabled);
    return;
  }
  applyOpenAtLogin(enabled);
};

const syncLoginItem = (): void => {
  applyOpenAtLogin(readLaunchAtLogin());
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
    store.write(readOpenAtLogin());
  }
  syncLoginItem();
  teardown = store.subscribe(syncLoginItem);
};

export const __resetLoginItemForTesting = (): void => {
  teardown?.();
  teardown = null;
  runtime = null;
};
