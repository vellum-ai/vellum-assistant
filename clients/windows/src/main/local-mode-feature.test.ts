import { beforeEach, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  app: {
    getAppPath: () => import.meta.dir,
    getPath: () => import.meta.dir,
    getVersion: () => "0.0.0",
    isPackaged: false,
  },
}));

const installLocalMode = mock(() => undefined);
mock.module("@vellumai/electron-desktop/local-mode", () => ({
  installLocalMode,
}));

const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");
const { default: localModeFeature } = await import("./features/local-mode");

beforeEach(() => {
  mock.clearAllMocks();
});

test("installs the configured local-mode runtime", () => {
  const registry = new DesktopCapabilityRegistry();

  localModeFeature.install(registry);

  expect(installLocalMode).toHaveBeenCalledTimes(1);
});
