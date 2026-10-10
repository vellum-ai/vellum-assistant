import { afterEach, expect, mock, test } from "bun:test";

const quitListeners: Array<() => void> = [];

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp",
    once: (event: string, listener: () => void) => {
      if (event === "before-quit") {
        quitListeners.push(listener);
      }
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: {
    on: () => undefined,
    off: () => undefined,
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => "active",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

mock.module("./logger", () => ({
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const { __testing } =
  await import("@vellumai/electron-desktop/host-proxy/router");
const { default: hostProxyFeature } = await import("./features/host-proxy");
const { COMPUTER_USE_ACTION_EXECUTORS } =
  await import("./features/computer-use-actions");
const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");

afterEach(() => {
  __testing.reset();
  quitListeners.length = 0;
});

test("installs the bridge with the portable executors and tears down on quit", async () => {
  hostProxyFeature.install(new DesktopCapabilityRegistry());

  // The bridge install is deferred a microtask so the lockfile watcher's
  // initial read (a later-sorted feature) lands first.
  expect(__testing.executors.size).toBe(0);
  await Bun.sleep(0);

  // An empty registry contributes no computer-use executor.
  expect([...__testing.executors.keys()].sort()).toEqual([
    "host_bash",
    "host_browser",
    "host_file",
    "host_transfer",
    "host_ui_snapshot",
  ]);
  expect(__testing.connections.size).toBe(0);

  expect(quitListeners).toHaveLength(1);
  quitListeners[0]!();
  expect(__testing.executors.size).toBe(0);
});

test("installs the computer-use executor contributed by its capability", async () => {
  const registry = new DesktopCapabilityRegistry();
  registry.provide(COMPUTER_USE_ACTION_EXECUTORS, {
    host_cu: {
      handleRequest: () => undefined,
      handleCancel: () => undefined,
    },
    teardown: () => undefined,
  });

  hostProxyFeature.install(registry);
  await Bun.sleep(0);

  expect(__testing.executors.has("host_cu")).toBe(true);
});
