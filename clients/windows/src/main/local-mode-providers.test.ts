import { beforeEach, expect, mock, test } from "bun:test";

import type { BundleHostProvider } from "@vellumai/electron-desktop/bundle-platform";
import type { CapabilityToken } from "@vellumai/electron-desktop/capability-registry";

const configureLocalMode = mock(() => undefined);
const getLocalGuardianAccessToken = mock(async (_assistantId: string) => ({
  ok: true as const,
  accessToken: "guardian-token",
}));
const cliToken = { id: "desktop.local-mode-cli" };
const pathsToken = { id: "desktop.local-mode-paths" };
const sessionToken = { id: "desktop.local-mode-session" };
const bundleHostProviderToken = {
  id: "desktop.bundle-host-provider",
} as CapabilityToken<BundleHostProvider>;
const resolveActiveBundleGateway = mock(() => ({
  assistantId: "assistant-1",
  port: 9000,
}));

mock.module("electron", () => ({
  app: {
    getAppPath: () => "C:\\Vellum",
    getPath: () => "C:\\Vellum",
    getVersion: () => "1.0.0",
    isPackaged: true,
  },
}));

mock.module("@vellumai/electron-desktop/local-mode", () => ({
  configureLocalMode,
  getLocalGuardianAccessToken,
  LOCAL_MODE_CLI: cliToken,
  LOCAL_MODE_PATHS: pathsToken,
  LOCAL_MODE_SESSION: sessionToken,
}));
mock.module("@vellumai/electron-desktop/bundle-platform", () => ({
  bundleHostProviderToken,
  resolveActiveBundleGateway,
}));

mock.module("@vellumai/electron-desktop/lockfile-watcher", () => ({
  refreshLockfileNow: mock(() => undefined),
}));
mock.module("@vellumai/electron-desktop/permissions", () => ({
  denyAllPermissions: mock(() => undefined),
}));
mock.module("@vellumai/electron-desktop/session-token-store", () => ({
  getSessionToken: () => "session-token",
}));
mock.module("./cli-installer", () => ({
  provisionCliRuntime: mock(() => ({ installDir: "C:\\Vellum\\cli" })),
  resolveCliRuntimePaths: mock(() => ({})),
}));
mock.module("./ipc.client", () => ({ handle: mock(() => undefined) }));

mock.module("@vellumai/local-mode", () => ({
  resolveConfigDir: () => "C:\\Vellum\\config",
  resolveDevCliInvocation: mock(() => ({ command: "bun", baseArgs: [] })),
  resolveEnvironmentName: () => "production",
  resolveLockfilePaths: () => ["C:\\Vellum\\lock.json"],
}));

const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");
const { installWindowsLocalModeProviders } =
  await import("./local-mode-providers");

beforeEach(() => {
  configureLocalMode.mockClear();
  getLocalGuardianAccessToken.mockClear();
  resolveActiveBundleGateway.mockClear();
  resolveActiveBundleGateway.mockReturnValue({
    assistantId: "assistant-1",
    port: 9000,
  });
});

test("provides the active gateway and its guardian token to bundle flows", async () => {
  const registry = new DesktopCapabilityRegistry();
  installWindowsLocalModeProviders(registry);
  const host = registry.require(bundleHostProviderToken);

  expect(host.resolveActiveGateway()).toEqual({
    assistantId: "assistant-1",
    port: 9000,
  });
  expect(await host.acquireGatewayToken("assistant-1")).toBe("guardian-token");
  expect(getLocalGuardianAccessToken).toHaveBeenCalledWith("assistant-1");
});
