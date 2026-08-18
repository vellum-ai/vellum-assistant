import { beforeEach, describe, expect, mock, test } from "bun:test";

const installBundleFlowMock = mock(() => undefined);
const handleBundleFileMock = mock(async (_filePath: string) => undefined);
const stopFileOpenMock = mock(() => undefined);
const onFileOpenMock = mock(
  (_handler: (filePath: string) => void) => stopFileOpenMock,
);
const appOnceMock = mock((_event: string, _handler: () => void) => undefined);
const registerGetDataMock = mock((_handler: () => unknown) => undefined);
const registerResponseMock = mock(
  (_handler: (accepted: boolean) => void) => undefined,
);

mock.module("electron", () => ({
  app: {
    getPath: () => "C:\\Vellum",
    isPackaged: true,
    once: appOnceMock,
  },
}));

mock.module("@vellumai/electron-desktop/bundle-flow", () => ({
  installBundleFlow: installBundleFlowMock,
  handleBundleFile: handleBundleFileMock,
}));

mock.module("@vellumai/electron-desktop/file-open", () => ({
  onFileOpen: onFileOpenMock,
}));

mock.module("./ipc.client", () => ({
  handle: (_channel: string, _schema: unknown, handler: () => unknown) => {
    registerGetDataMock(handler);
  },
  on: (
    _channel: string,
    _schema: unknown,
    handler: (args: [boolean]) => void,
  ) => {
    registerResponseMock((accepted) => {
      handler([accepted]);
    });
  },
}));

const {
  bundleFileHandlerToken,
  bundleHostProviderToken,
  getBundlePlatform,
  resetBundlePlatformForTest,
} = await import("@vellumai/electron-desktop/bundle-platform");
const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");
const { default: bundles } = await import("./features/bundles");

beforeEach(() => {
  resetBundlePlatformForTest();
  installBundleFlowMock.mockClear();
  handleBundleFileMock.mockClear();
  onFileOpenMock.mockClear();
  stopFileOpenMock.mockClear();
  appOnceMock.mockClear();
  registerGetDataMock.mockClear();
  registerResponseMock.mockClear();
});

describe("Windows bundle workflow", () => {
  test("stays disabled without a host provider", () => {
    const registry = new DesktopCapabilityRegistry();
    bundles.install(registry);

    expect(registry.get(bundleFileHandlerToken)).toBeUndefined();
    expect(installBundleFlowMock).not.toHaveBeenCalled();
    expect(onFileOpenMock).not.toHaveBeenCalled();
  });

  test("installs through an explicit host provider", () => {
    const registry = new DesktopCapabilityRegistry();
    const denyAllPermissions = mock(() => undefined);
    registry.provide(bundleHostProviderToken, {
      resolveActiveGateway: () => ({ assistantId: "assistant-1", port: 9000 }),
      acquireGatewayToken: async () => "token",
      denyAllPermissions,
    });

    bundles.install(registry);

    expect(registry.get(bundleFileHandlerToken)).toBe(handleBundleFileMock);
    expect(installBundleFlowMock).toHaveBeenCalledTimes(1);
    expect(onFileOpenMock).toHaveBeenCalledTimes(1);
    onFileOpenMock.mock.calls[0]![0]("C:\\bundle.vellum");
    expect(handleBundleFileMock).toHaveBeenCalledWith("C:\\bundle.vellum");
    expect(appOnceMock).toHaveBeenCalledWith("before-quit", stopFileOpenMock);
    expect(getBundlePlatform().bundlesRoot()).toBe("C:\\Vellum/bundles");
  });
});
