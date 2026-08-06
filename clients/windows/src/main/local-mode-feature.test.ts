import { beforeEach, expect, mock, test } from "bun:test";

const once = mock(() => undefined);
mock.module("electron", () => ({ app: { once } }));

const cliToken = { id: "desktop.local-mode-cli" };
const pathsToken = { id: "desktop.local-mode-paths" };
const sessionToken = { id: "desktop.local-mode-session" };
const configureLocalMode = mock(() => undefined);
const configureUnavailableLocalMode = mock(() => undefined);
const installLocalMode = mock(() => undefined);
mock.module("@vellumai/electron-desktop/local-mode", () => ({
  configureLocalMode,
  configureUnavailableLocalMode,
  installLocalMode,
  LOCAL_MODE_CLI: cliToken,
  LOCAL_MODE_PATHS: pathsToken,
  LOCAL_MODE_SESSION: sessionToken,
}));

const configureLockfileWatcher = mock(() => undefined);
const teardownWatcher = mock(() => undefined);
const installLockfileWatcher = mock(() => teardownWatcher);
const refreshLockfileNow = mock(() => undefined);
mock.module("@vellumai/electron-desktop/lockfile-watcher", () => ({
  configureLockfileWatcher,
  installLockfileWatcher,
  refreshLockfileNow,
}));
mock.module("./ipc.client", () => ({ handle: mock(() => undefined) }));

const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");
const { default: localModeFeature } = await import("./features/local-mode");

beforeEach(() => {
  mock.clearAllMocks();
});

test("installs an explicit unavailable surface without runtime providers", () => {
  const registry = new DesktopCapabilityRegistry();
  localModeFeature.install(registry);

  expect(configureUnavailableLocalMode).toHaveBeenCalledWith(
    expect.any(Function),
    "Local mode is unavailable until its Windows providers are installed.",
  );
  expect(installLocalMode).toHaveBeenCalledTimes(1);
  expect(installLockfileWatcher).not.toHaveBeenCalled();
});

test("installs the full runtime when every provider is present", () => {
  const registry = new DesktopCapabilityRegistry();

  const cli = {
    resolveInvocation: mock(async () => ({ command: "vellum", baseArgs: [] })),
  };
  const paths = {
    configDir: "/config",
    environment: "production",
    lockfilePaths: ["/lockfile"],
  };
  const session = { getToken: () => "token" };
  registry.provide(cliToken, cli);
  registry.provide(pathsToken, paths);
  registry.provide(sessionToken, session);

  localModeFeature.install(registry);

  expect(configureLocalMode).toHaveBeenCalledWith(
    expect.objectContaining({ cli, paths, session }),
  );
  expect(installLocalMode).toHaveBeenCalledTimes(1);
  expect(installLockfileWatcher).toHaveBeenCalledTimes(1);
  expect(once).toHaveBeenCalledWith("before-quit", teardownWatcher);
});
