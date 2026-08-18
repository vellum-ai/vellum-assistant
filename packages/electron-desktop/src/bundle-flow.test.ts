import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { BundleScanData, BundleMetadata } from "./bundle-manager";

// ---------------------------------------------------------------------------
// Stubs and mocks
// ---------------------------------------------------------------------------

const showErrorBoxMock = mock((_title: string, _content: string) => undefined);
const netFetchMock = mock(
  async (_url: string, _opts?: RequestInit) =>
    new Response(null, { status: 500 }),
);

mock.module("electron", () => ({
  dialog: { showErrorBox: showErrorBoxMock },
  net: { fetch: netFetchMock },
}));

const resolveActiveGatewayMock = mock(
  (): { assistantId: string; port: number } | null => null,
);
const acquireGatewayTokenMock = mock(
  async (_assistantId: string) => "fake-token",
);

mock.module("./bundle-platform", () => ({
  getBundlePlatform: () => ({
    resolveActiveGateway: resolveActiveGatewayMock,
    acquireGatewayToken: acquireGatewayTokenMock,
    bundlesRoot: () => "/fake/user-data/bundles",
  }),
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

const { handleBundleFile, installBundleFlow } = await import("./bundle-flow");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_SCAN: BundleScanData = {
  manifest: {
    format_version: 2,
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

beforeEach(() => {
  showErrorBoxMock.mockClear();
  netFetchMock.mockClear();
  resolveActiveGatewayMock.mockClear();
  acquireGatewayTokenMock.mockClear();
  openBundleConfirmationMock.mockClear();
  installBundleConfirmationMock.mockClear();
  unpackBundleMock.mockClear();
  openBundleWindowMock.mockClear();
  resolveActiveGatewayMock.mockReturnValue(null);
  openBundleConfirmationMock.mockResolvedValue(true);
  acquireGatewayTokenMock.mockResolvedValue("fake-token");
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
  resolveActiveGatewayMock.mockReset();
  netFetchMock.mockReset();
  openBundleConfirmationMock.mockReset();
  unpackBundleMock.mockReset();
  acquireGatewayTokenMock.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleBundleFile", () => {
  test("shows error when the assistant is unavailable", async () => {
    await handleBundleFile("/tmp/test.vellum");

    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    expect(showErrorBoxMock.mock.calls[0]?.[0]).toBe("Cannot open bundle");
    expect(openBundleConfirmationMock).not.toHaveBeenCalled();
  });

  test("shows error when scan fails", async () => {
    resolveActiveGatewayMock.mockReturnValue({ assistantId: "a1", port: 9000 });
    netFetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    await handleBundleFile("/tmp/test.vellum");

    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    expect(showErrorBoxMock.mock.calls[0]?.[1]).toContain("Failed to scan");
    expect(openBundleConfirmationMock).not.toHaveBeenCalled();
  });

  test("shows error for blocked findings without opening confirmation", async () => {
    resolveActiveGatewayMock.mockReturnValue({ assistantId: "a1", port: 9000 });
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
    resolveActiveGatewayMock.mockReturnValue({ assistantId: "a1", port: 9000 });
    openBundleConfirmationMock.mockResolvedValue(false);

    await handleBundleFile("/tmp/test.vellum");

    expect(openBundleConfirmationMock).toHaveBeenCalledTimes(1);
    expect(unpackBundleMock).not.toHaveBeenCalled();
    expect(openBundleWindowMock).not.toHaveBeenCalled();
  });

  test("shows error when unpack fails", async () => {
    resolveActiveGatewayMock.mockReturnValue({ assistantId: "a1", port: 9000 });
    unpackBundleMock.mockRejectedValue(new Error("disk full"));

    await handleBundleFile("/tmp/test.vellum");

    expect(showErrorBoxMock).toHaveBeenCalledTimes(1);
    expect(showErrorBoxMock.mock.calls[0]?.[1]).toContain("disk full");
    expect(openBundleWindowMock).not.toHaveBeenCalled();
  });

  test("sends auth token in scan request", async () => {
    resolveActiveGatewayMock.mockReturnValue({ assistantId: "a1", port: 9000 });

    await handleBundleFile("/tmp/test.vellum");

    const fetchCall = netFetchMock.mock.calls[0];
    const opts = fetchCall?.[1] as RequestInit | undefined;
    const headers = opts?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer fake-token");
  });

  test("success flow: scans, confirms, unpacks, opens window", async () => {
    resolveActiveGatewayMock.mockReturnValue({ assistantId: "a1", port: 9000 });

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
