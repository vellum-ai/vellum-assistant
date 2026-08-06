import { beforeEach, expect, mock, test } from "bun:test";

import type { IpcHandle } from "./ipc";

let openAtLogin = false;
const getLoginItemSettings = mock(() => ({ openAtLogin }));
const setLoginItemSettings = mock((settings: { openAtLogin: boolean }) => {
  openAtLogin = settings.openAtLogin;
});

mock.module("electron", () => ({
  app: {
    getLoginItemSettings,
    setLoginItemSettings,
  },
}));

const {
  __resetLoginItemForTesting,
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} = await import("./login-item");

type Handler = (args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const handle: IpcHandle = (channel, _schema, fn): void => {
  handlers.set(channel, (args) => fn(args as never, {} as never));
};

beforeEach(() => {
  __resetLoginItemForTesting();
  handlers.clear();
  openAtLogin = false;
  setLoginItemSettings.mockClear();
  getLoginItemSettings.mockClear();
});

test("identifies the app entry for an unpackaged login item", () => {
  const identity = { path: "/path/to/electron", args: ["/path/to/app"] };
  configureLoginItem({ handle, identity });
  installLoginItemIpc();

  expect(handlers.get("vellum:launchAtLogin:get")?.([])).toBe(false);
  handlers.get("vellum:launchAtLogin:set")?.([true]);

  expect(getLoginItemSettings).toHaveBeenCalledWith(identity);
  expect(setLoginItemSettings).toHaveBeenCalledWith({
    openAtLogin: true,
    ...identity,
  });
});

test("reads and changes the operating-system login item", () => {
  configureLoginItem({ handle });
  installLoginItemIpc();

  expect(handlers.get("vellum:launchAtLogin:get")?.([])).toBe(false);
  handlers.get("vellum:launchAtLogin:set")?.([true]);

  expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  expect(handlers.get("vellum:launchAtLogin:get")?.([])).toBe(true);
});

test("keeps a persisted setting synchronized with the login item", () => {
  let stored: boolean | null = null;
  let notify = (): void => undefined;
  const write = mock((enabled: boolean) => {
    stored = enabled;
  });

  configureLoginItem({
    handle,
    store: {
      read: () => stored,
      subscribe: (next) => {
        notify = next;
        return () => {
          notify = () => undefined;
        };
      },
      write,
    },
  });

  installLoginItem();
  installLoginItemIpc();

  expect(write).toHaveBeenCalledWith(false);
  expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });

  handlers.get("vellum:launchAtLogin:set")?.([true]);
  notify();

  expect(write).toHaveBeenLastCalledWith(true);
  expect(setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
});
