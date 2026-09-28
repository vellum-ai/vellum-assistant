import { beforeEach, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  app: {
    getAppPath: () => import.meta.dir,
    getPath: () => import.meta.dir,
    getVersion: () => "0.0.0",
    isPackaged: false,
  },
}));

const configureLocalMode = mock(() => undefined);
const installLocalMode = mock(() => undefined);
mock.module("@vellumai/electron-desktop/local-mode", () => ({
  configureLocalMode,
  installLocalMode,
  LOCAL_MODE_CLI: { id: "desktop.local-mode-cli" },
  LOCAL_MODE_PATHS: { id: "desktop.local-mode-paths" },
  LOCAL_MODE_SESSION: { id: "desktop.local-mode-session" },
}));

const refreshLockfileNow = mock(() => undefined);
mock.module("@vellumai/electron-desktop/lockfile-watcher", () => ({
  refreshLockfileNow,
}));
mock.module("./ipc.client", () => ({ handle: mock(() => undefined) }));
mock.module("./logger", () => ({
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));
mock.module("@vellumai/electron-desktop/session-token-store", () => ({
  getSessionToken: () => "session-token",
}));

const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");
const { default: localModeFeature } = await import("./features/local-mode");

beforeEach(() => {
  mock.clearAllMocks();
});

test("installs the full runtime with the Linux providers", () => {
  const registry = new DesktopCapabilityRegistry();

  localModeFeature.install(registry);

  expect(configureLocalMode).toHaveBeenCalledWith(
    expect.objectContaining({
      cli: expect.objectContaining({ resolveInvocation: expect.any(Function) }),
      paths: expect.objectContaining({ lockfilePaths: expect.any(Array) }),
      refreshLockfile: refreshLockfileNow,
      session: expect.objectContaining({ getToken: expect.any(Function) }),
    }),
  );
  expect(installLocalMode).toHaveBeenCalledTimes(1);
});
