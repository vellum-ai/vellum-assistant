import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { BundleScanData, BundleMetadata } from "./bundle-manager";

// ---------------------------------------------------------------------------
// Stubs and mocks
// ---------------------------------------------------------------------------

const showErrorBoxMock = mock((_title: string, _content: string) => undefined);
const getPathMock = mock((_name: string) => "/fake/user-data");
const getAppPathMock = mock(() => "/fake/app");
const netFetchMock = mock(
  async (_url: string, _opts?: RequestInit) =>
    new Response(null, { status: 500 }),
);

mock.module("electron", () => ({
  app: { getPath: getPathMock, getAppPath: getAppPathMock, isPackaged: true },
  dialog: { showErrorBox: showErrorBoxMock },
  net: { fetch: netFetchMock },
  ipcMain: {
    handle: mock(() => undefined),
    on: mock(() => undefined),
  },
  BrowserWindow: class {},
}));

const getLockfileDataMock = mock(
  (
    _paths: string[],
  ): { ok: true; data: unknown } | { ok: false; status: number } => ({
    ok: false as const,
    status: 500,
  }),
);
const resolveLockfilePathsMock = mock((_env: NodeJS.ProcessEnv) => [
  "/fake/lockfile",
]);
const resolveConfigDirMock = mock((_env: NodeJS.ProcessEnv) => "/fake/config");
const getGuardianAccessTokenMock = mock(async () => ({
  ok: true as const,
  accessToken: "fake-token",
}));

// Full `@vellumai/local-mode` surface so the real `./local-mode` (imported by
// bundle-flow for resolveCliInvocation) links cleanly.
mock.module("@vellumai/local-mode", () => ({
  getLockfileData: getLockfileDataMock,
  resolveLockfilePaths: resolveLockfilePathsMock,
  resolveConfigDir: resolveConfigDirMock,
  resolveEnvironmentName: mock((_env: NodeJS.ProcessEnv) => "production"),
  isActiveAssistant: mock(() => true),
  getGuardianAccessToken: getGuardianAccessTokenMock,
  replacePlatformAssistants: mock(() => ({ ok: false, error: "unused" })),
  upsertLockfileAssistant: mock(() => ({ ok: false, error: "unused" })),
  runHatch: mock(async () => ({ ok: false, error: "unused" })),
  runRetire: mock(async () => ({ ok: false, error: "unused" })),
  runSleep: mock(async () => ({ ok: false, error: "unused" })),
  runUpgrade: mock(async () => ({ ok: false, error: "unused" })),
  runWake: mock(async () => ({ ok: false, error: "unused" })),
  getLocalAssistantStatus: mock(async () => ({ ok: true, state: "sleeping" })),
}));

const ensureCliInstalledMock = mock(async () => undefined);

mock.module("./cli-installer", () => ({
  isCliInstalled: () => true,
  getBundledBunPath: () => "/fake/bun",
  getCliBinPath: () => "/fake/cli",
  ensureCliInstalled: ensureCliInstalledMock,
}));

mock.module("./session-token-store", () => ({
  getSessionToken: () => null,
}));

const openBundleConfirmationMock = mock(async (_data: BundleScanData) => true);
const installBundleConfirmationMock = mock(() => undefined);

mock.module("./bundle-confirmation", () => ({
  openBundleConfirmation: openBundleConfirmationMock,
  installBundleConfirmation: installBundleConfirmationMock,
}));

const unpackBundleMock = mock(
  async (
    _root: string,
    _zip: string,
    _scan: BundleScanData,
  ): Promise<BundleMetadata> => ({
    uuid: "test-uuid",
    name: "Test",
    entry: "index.html",
    trustTier: "signed",
    installedAt: new Date().toISOString(),
    bundleSizeBytes: 100,
    capabilities: [],
  }),
);

mock.module("./bundle-manager", () => ({
  unpackBundle: unpackBundleMock,
}));

const openBundleWindowMock = mock(
  (_uuid: string, _entry: string, _name: string) => ({}) as unknown,
);

mock.module("./bundle-window", () => ({
  openBundleWindow: openBundleWindowMock,
}));

// Full `./app-config` surface so this mock — which leaks into co-run test
// files via the global module registry — doesn't break sibling modules
// (notably `./app-origin`, loaded via the real `./local-mode` → `./ipc`).
mock.module("./app-config", () => ({
  APP_PROTOCOL: "app",
  APP_HOST: "vellum.ai",
  VELLUMAPP_PROTOCOL: "vellumapp",
  BUNDLES_DIR_NAME: "bundles",
  RENDERER_BASE_PROD: "app://vellum.ai/assistant",
  getDevRendererBase: () => "http://localhost:5173",
  getRendererRootUrl: () => "app://vellum.ai/assistant",
}));

// resolveCliInvocation (via the real `./local-mode`) honors this override;
// clear it so packaged-path assertions are deterministic.
delete process.env.VELLUM_CLI_PATH;

const { handleBundleFile, resolveActiveGateway, installBundleFlow } =
  await import("./bundle-flow");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_SCAN: BundleScanData = {
  manifest: {
    format_version: 1,
    name: "Test Bundle",
    description: "A test",
    entry: "index.html",
    capabilities: [],
    created_by: "user@example.com",
    created_at: "2025-01-01T00:00:00Z",
  },
  scanResult: { passed: true, blocked: [], warnings: [] },
  signatureResult: { trustTier: "signed", signerDisplayName: "Example User" },
  bundleSizeBytes: 1234,
};

const makeLockfileWithPort = (port: number) => ({
  ok: true as const,
  data: {
    assistants: [
      {
        assistantId: "a1",
        resources: { gatewayPort: port, daemonPort: port + 1 },
      },
    ],
    activeAssistant: "a1",
  },
});

beforeEach(() => {
  showErrorBoxMock.mockClear();
  netFetchMock.mockClear();
  getLockfileDataMock.mockClear();
  getGuardianAccessTokenMock.mockClear();
  openBundleConfirmationMock.mockClear();
  installBundleConfirmationMock.mockClear();
  unpackBundleMock.mockClear();
  openBundleWindowMock.mockClear();
  ensureCliInstalledMock.mockClear();

  getLockfileDataMock.mockReturnValue({ ok: false, status: 500 });
  openBundleConfirmationMock.mockResolvedValue(true);
  getGuardianAccessTokenMock.mockResolvedValue({
    ok: true as const,
    accessToken: "fake-token",
  });
  netFetchMock.mockResolvedValue(
    new Response(JSON.stringify(SAMPLE_SCAN), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  unpackBundleMock.mockResolvedValue({
    uuid: "test-uuid",
    name: "Test",
    entry: "index.html",
    trustTier: "signed",
    installedAt: new Date().toISOString(),
    bundleSizeBytes: 100,
    capabilities: [],
  });
});

afterEach(() => {
  getLockfileDataMock.mockReset();
  netFetchMock.mockReset();
  openBundleConfirmationMock.mockReset();
  unpackBundleMock.mockReset();
  getGuardianAccessTokenMock.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveActiveGateway", () => {
  test("returns null when lockfile read fails", () => {
    getLockfileDataMock.mockReturnValue({ ok: false, status: 500 });
    expect(resolveActiveGateway()).toBeNull();
  });

  test("returns null when no active assistant", () => {
    getLockfileDataMock.mockReturnValue({
      ok: true,
      data: {
        assistants: [{ assistantId: "a1", resources: { gatewayPort: 9000 } }],
        activeAssistant: null,
      },
    });
    expect(resolveActiveGateway()).toBeNull();
  });

  test("returns null when active assistant has no gateway port", () => {
    getLockfileDataMock.mockReturnValue({
      ok: true,
      data: {
        assistants: [{ assistantId: "a1" }],
        activeAssistant: "a1",
      },
    });
    expect(resolveActiveGateway()).toBeNull();
  });

  test("returns the active assistant gateway port", () => {
    getLockfileDataMock.mockReturnValue(makeLockfileWithPort(9000));
    expect(resolveActiveGateway()).toEqual({
      assistantId: "a1",
      port: 9000,
    });
  });
});

describe("handleBundleFile", () => {
  test("shows error when daemon is unavailable", async () => {
    getLockfileDataMock.mockReturnValue({ ok: false, status: 500 });

    await handleBundleFile("/tmp/test.vellum");

    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    expect(showErrorBoxMock.mock.calls[0]?.[0]).toBe("Cannot open bundle");
    expect(openBundleConfirmationMock).not.toHaveBeenCalled();
  });

  test("shows error when scan fails", async () => {
    getLockfileDataMock.mockReturnValue(makeLockfileWithPort(9000));
    netFetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    await handleBundleFile("/tmp/test.vellum");

    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    expect(showErrorBoxMock.mock.calls[0]?.[1]).toContain("Failed to scan");
    expect(openBundleConfirmationMock).not.toHaveBeenCalled();
  });

  test("shows error for blocked findings without opening confirmation", async () => {
    getLockfileDataMock.mockReturnValue(makeLockfileWithPort(9000));
    const blockedScan: BundleScanData = {
      ...SAMPLE_SCAN,
      scanResult: {
        passed: false,
        blocked: ["Detected malicious script"],
        warnings: [],
      },
    };
    netFetchMock.mockResolvedValue(
      new Response(JSON.stringify(blockedScan), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await handleBundleFile("/tmp/test.vellum");

    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    expect(showErrorBoxMock.mock.calls[0]?.[0]).toBe("Bundle blocked");
    expect(showErrorBoxMock.mock.calls[0]?.[1]).toContain(
      "Detected malicious script",
    );
    expect(openBundleConfirmationMock).not.toHaveBeenCalled();
  });

  test("does not unpack when user cancels confirmation", async () => {
    getLockfileDataMock.mockReturnValue(makeLockfileWithPort(9000));
    openBundleConfirmationMock.mockResolvedValue(false);

    await handleBundleFile("/tmp/test.vellum");

    expect(openBundleConfirmationMock).toHaveBeenCalledTimes(1);
    expect(unpackBundleMock).not.toHaveBeenCalled();
    expect(openBundleWindowMock).not.toHaveBeenCalled();
  });

  test("shows error when unpack fails", async () => {
    getLockfileDataMock.mockReturnValue(makeLockfileWithPort(9000));
    unpackBundleMock.mockRejectedValue(new Error("disk full"));

    await handleBundleFile("/tmp/test.vellum");

    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    expect(showErrorBoxMock.mock.calls[0]?.[1]).toContain("disk full");
    expect(openBundleWindowMock).not.toHaveBeenCalled();
  });

  test("sends auth token in scan request", async () => {
    getLockfileDataMock.mockReturnValue(makeLockfileWithPort(9000));

    await handleBundleFile("/tmp/test.vellum");

    const fetchCall = netFetchMock.mock.calls[0];
    const opts = fetchCall?.[1] as RequestInit | undefined;
    const headers = opts?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer fake-token");
  });

  test("refreshes the CLI locator via ensureCliInstalled even when already installed", async () => {
    getLockfileDataMock.mockReturnValue(makeLockfileWithPort(9000));

    await handleBundleFile("/tmp/test.vellum");

    expect(ensureCliInstalledMock).toHaveBeenCalledTimes(1);
  });

  test("success flow: scans, confirms, unpacks, opens window", async () => {
    getLockfileDataMock.mockReturnValue(makeLockfileWithPort(9000));

    await handleBundleFile("/tmp/test.vellum");

    expect(netFetchMock).toHaveBeenCalledTimes(1);
    expect(openBundleConfirmationMock).toHaveBeenCalledWith(SAMPLE_SCAN);
    expect(unpackBundleMock).toHaveBeenCalledTimes(1);
    expect(openBundleWindowMock).toHaveBeenCalledWith(
      "test-uuid",
      "index.html",
      "Test Bundle",
    );
  });
});

describe("installBundleFlow", () => {
  test("delegates to installBundleConfirmation", () => {
    installBundleFlow();
    expect(installBundleConfirmationMock).toHaveBeenCalledTimes(1);
  });
});
