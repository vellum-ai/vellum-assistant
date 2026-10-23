import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry as Registry,
} from "../capability-registry";

export async function runBundleFeatureSuite(
  platform: string,
  loadFeature: () => Promise<{ default: CapabilityModule<Registry> }>,
  paths: {
    appData: string;
    config: string;
    bundleFile: string;
    command: string;
  },
) {
  const installBundleFlowMock = mock(() => undefined);
  const handleBundleFileMock = mock(async (_filePath: string) => undefined);
  const stopFileOpenMock = mock(() => undefined);
  const onFileOpenMock = mock(
    (_handler: (filePath: string) => void) => stopFileOpenMock,
  );
  const appOnceMock = mock((_event: string, _handler: () => void) => undefined);
  const resolveInvocationMock = mock(async () => ({
    command: paths.command,
    baseArgs: [] as string[],
  }));
  const getGuardianAccessTokenMock = mock(async () => ({
    ok: true as const,
    accessToken: "guardian-token",
  }));

  mock.module("electron", () => ({
    app: {
      getPath: () => paths.appData,
      isPackaged: true,
      once: appOnceMock,
    },
    BrowserWindow: class {},
    session: { defaultSession: {} },
    shell: {},
  }));

  mock.module("@vellumai/electron-desktop/bundle-flow", () => ({
    installBundleFlow: installBundleFlowMock,
    handleBundleFile: handleBundleFileMock,
  }));

  mock.module("@vellumai/electron-desktop/file-open", () => ({
    onFileOpen: onFileOpenMock,
  }));

  const localMode = await import("@vellumai/local-mode");
  mock.module("@vellumai/local-mode", () => ({
    ...localMode,
    getGuardianAccessToken: getGuardianAccessTokenMock,
    getLockfileData: () => ({ ok: false, error: "missing" }),
    resolveConfigDir: () => paths.config,
    resolveLockfilePaths: () => [join(paths.config, "lockfile.json")],
  }));

  const {
    bundleFileHandlerToken,
    getBundlePlatform,
    resetBundlePlatformForTest,
  } = await import("@vellumai/electron-desktop/bundle-platform");
  const { DesktopCapabilityRegistry } =
    await import("@vellumai/electron-desktop/capability-registry");
  const { LOCAL_MODE_CLI } =
    await import("@vellumai/electron-desktop/local-mode");
  const { default: bundles } = await loadFeature();

  beforeEach(() => {
    resetBundlePlatformForTest();
    installBundleFlowMock.mockClear();
    handleBundleFileMock.mockClear();
    onFileOpenMock.mockClear();
    stopFileOpenMock.mockClear();
    appOnceMock.mockClear();
    resolveInvocationMock.mockClear();
    getGuardianAccessTokenMock.mockClear();
  });

  describe(`${platform} bundle workflow`, () => {
    test("installs the bundle flow and file-open handler", () => {
      const registry = new DesktopCapabilityRegistry();
      bundles.install(registry);

      expect(registry.get(bundleFileHandlerToken)).toBe(handleBundleFileMock);
      expect(installBundleFlowMock).toHaveBeenCalledTimes(1);
      expect(onFileOpenMock).toHaveBeenCalledTimes(1);
      onFileOpenMock.mock.calls[0]![0](paths.bundleFile);
      expect(handleBundleFileMock).toHaveBeenCalledWith(paths.bundleFile);
      expect(appOnceMock).toHaveBeenCalledWith("before-quit", stopFileOpenMock);
      expect(getBundlePlatform().bundlesRoot()).toBe(
        join(paths.appData, "bundles"),
      );
    });

    test("mints gateway tokens through the CLI provider installed later", async () => {
      const registry = new DesktopCapabilityRegistry();
      bundles.install(registry);

      // Without the provider, the token request degrades to null.
      await expect(
        getBundlePlatform().acquireGatewayToken("assistant-1"),
      ).resolves.toBeNull();

      // A cold launch from a `.vellum` file asks for the token in the same
      // tick that installs the remaining modules, including the CLI provider.
      const pending = getBundlePlatform().acquireGatewayToken("assistant-1");
      registry.provide(LOCAL_MODE_CLI, {
        resolveInvocation: resolveInvocationMock,
      });
      await expect(pending).resolves.toBe("guardian-token");
      expect(getGuardianAccessTokenMock).toHaveBeenCalledWith(
        "assistant-1",
        paths.config,
        { command: paths.command, baseArgs: [] },
        true,
      );
    });
  });
}
