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
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: {
        file: {
          maxSize: 0,
          fileName: "",
          format: "",
          getFile: () => ({ path: "" }),
        },
      },
    },
  };
});

const { __testing } =
  await import("@vellumai/electron-desktop/host-proxy/router");
const { default: hostProxyFeature } = await import("./features/host-proxy");
const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");

afterEach(() => {
  __testing.reset();
  quitListeners.length = 0;
});

test("installs the bridge with the portable executors and tears down on quit", () => {
  hostProxyFeature.install(new DesktopCapabilityRegistry());

  expect([...__testing.executors.keys()].sort()).toEqual([
    "host_bash",
    "host_browser",
    "host_file",
    "host_transfer",
    "host_ui_snapshot",
  ]);
  expect(__testing.connections.size).toBe(0);

  expect(quitListeners.length).toBe(1);
  quitListeners[0]();
  expect(__testing.executors.size).toBe(0);
});
