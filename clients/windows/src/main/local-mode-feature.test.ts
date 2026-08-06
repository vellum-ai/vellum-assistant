import { expect, mock, test } from "bun:test";

const once = mock(() => undefined);
mock.module("electron", () => ({ app: { once } }));

const cliToken = { id: "desktop.local-mode-cli" };
const pathsToken = { id: "desktop.local-mode-paths" };
const sessionToken = { id: "desktop.local-mode-session" };
const configureLocalMode = mock(() => undefined);
const installLocalMode = mock(() => undefined);
mock.module("@vellumai/electron-desktop/local-mode", () => ({
  configureLocalMode,
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

test("installs only when every runtime provider is present", () => {
  const registry = new DesktopCapabilityRegistry();
  localModeFeature.install(registry);

  expect(installLocalMode).not.toHaveBeenCalled();
  expect(installLockfileWatcher).not.toHaveBeenCalled();

  const cli = { resolveInvocation: mock(async () => ({ command: "vellum" })) };
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
