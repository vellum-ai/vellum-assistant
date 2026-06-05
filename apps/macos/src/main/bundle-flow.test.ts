import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { BundleScanData, BundleMetadata } from "./bundle-manager";

// ---------------------------------------------------------------------------
// Stubs and mocks
// ---------------------------------------------------------------------------

const showErrorBoxMock = mock((_title: string, _content: string) => undefined);
const getPathMock = mock((_name: string) => "/fake/user-data");
const netFetchMock = mock(
  async (_url: string, _opts?: RequestInit) =>
    new Response(null, { status: 500 }),
);

mock.module("electron", () => ({
  app: { getPath: getPathMock },
  dialog: { showErrorBox: showErrorBoxMock },
  net: { fetch: netFetchMock },
  ipcMain: {
    handle: mock(() => undefined),
    on: mock(() => undefined),
  },
  BrowserWindow: class {},
}));

const getLockfileDataMock = mock(
  (_paths: string[]): { ok: true; data: unknown } | { ok: false; status: number } => ({
    ok: false as const,
    status: 500,
  }),
);
const resolveLockfilePathsMock = mock((_env: NodeJS.ProcessEnv) => [
  "/fake/lockfile",
]);

mock.module("@vellumai/local-mode", () => ({
  getLockfileData: getLockfileDataMock,
  resolveLockfilePaths: resolveLockfilePathsMock,
}));

const openBundleConfirmationMock = mock(
  async (_data: BundleScanData) => true,
);
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

mock.module("./app-config", () => ({
  BUNDLES_DIR_NAME: "bundles",
}));

const { handleBundleFile, resolveDaemonPort, installBundleFlow } =
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
  openBundleConfirmationMock.mockClear();
  installBundleConfirmationMock.mockClear();
  unpackBundleMock.mockClear();
  openBundleWindowMock.mockClear();

  getLockfileDataMock.mockReturnValue({ ok: false, status: 500 });
  openBundleConfirmationMock.mockResolvedValue(true);
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveDaemonPort", () => {
  test("returns null when lockfile read fails", () => {
    getLockfileDataMock.mockReturnValue({ ok: false, status: 500 });
    expect(resolveDaemonPort()).toBeNull();
  });

  test("returns null when no assistants have a gateway port", () => {
    getLockfileDataMock.mockReturnValue({
      ok: true,
      data: { assistants: [{ assistantId: "a1" }], activeAssistant: "a1" },
    });
    expect(resolveDaemonPort()).toBeNull();
  });

  test("returns the first assistant gateway port", () => {
    getLockfileDataMock.mockReturnValue(makeLockfileWithPort(9000));
    expect(resolveDaemonPort()).toBe(9000);
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
    expect(showErrorBoxMock.mock.calls[0]?.[1]).toContain("Detected malicious script");
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
