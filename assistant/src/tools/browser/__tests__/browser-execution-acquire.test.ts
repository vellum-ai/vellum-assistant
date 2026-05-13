/**
 * Tests for the target_client_id sticky-mode override in
 * acquireCdpClientWithMode (browser-execution.ts).
 *
 * Fix 1: when target_client_id is provided, the sticky backend kind
 * remembered from prior turns in the conversation must NOT be applied.
 * The factory must receive mode:"extension" so the request reaches the
 * host-browser proxy regardless of any prior local/cdp-inspect preference.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../../types.js";
import type { BrowserMode, CdpClientKind } from "../cdp-client/types.js";

// ---------------------------------------------------------------------------
// Captured call state
// ---------------------------------------------------------------------------

interface CdpClientCallOpts {
  mode?: BrowserMode;
  targetClientId?: string;
}

const getCdpClientCalls: CdpClientCallOpts[] = [];

function makeFakeScopedClient(kind: CdpClientKind, conversationId: string) {
  return {
    kind,
    conversationId,
    send: mock(async () => ({})),
    dispose: mock(() => {}),
  };
}

const getCdpClientMock = mock(
  (ctx: ToolContext, opts?: CdpClientCallOpts) => {
    getCdpClientCalls.push({
      mode: opts?.mode,
      targetClientId: opts?.targetClientId,
    });
    return makeFakeScopedClient("extension", ctx.conversationId);
  },
);

// ---------------------------------------------------------------------------
// Mutable sticky-kind control
// ---------------------------------------------------------------------------

let stickyKind: CdpClientKind | null = null;

const setPreferredBackendKindMock = mock(
  (_conversationId: string, _kind: CdpClientKind) => {},
);
const clearPreferredBackendKindMock = mock((_conversationId: string) => {});

// ---------------------------------------------------------------------------
// Module mocks (must be declared before dynamic import)
// ---------------------------------------------------------------------------

mock.module("../cdp-client/factory.js", () => ({
  getCdpClient: getCdpClientMock,
  buildCandidateList: mock(() => []),
  isDesktopAutoCooldownActive: () => false,
}));

mock.module("../browser-manager.js", () => ({
  browserManager: {
    getPreferredBackendKind: (_conversationId: string) => stickyKind,
    setPreferredBackendKind: setPreferredBackendKindMock,
    clearPreferredBackendKind: clearPreferredBackendKindMock,
    storeSnapshotBackendNodeMap: () => {},
    clearSnapshotBackendNodeMap: () => {},
    resolveSnapshotBackendNodeId: () => undefined,
    isInteractive: () => false,
    supportsRouteInterception: false,
  },
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    hostBrowser: {
      cdpInspect: {
        enabled: false,
        host: "localhost",
        port: 9222,
        probeTimeoutMs: 500,
        desktopAuto: { enabled: false, cooldownMs: 30_000 },
      },
    },
  }),
}));

mock.module("../../../daemon/host-browser-proxy.js", () => ({
  HostBrowserProxy: {
    get instance() {
      return {
        isAvailable: () => false,
        hasExtensionClient: () => false,
        request: () => Promise.reject(new Error("no extension")),
      };
    },
  },
}));

mock.module("../runtime-check.js", () => ({
  checkBrowserRuntime: async () => ({
    playwrightAvailable: true,
    chromiumInstalled: true,
    chromiumPath: "/tmp/chromium",
    error: null,
  }),
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    warn: () => {},
    info: () => {},
    error: () => {},
  }),
}));

// Import under test after all mock.module calls.
const { executeBrowserAttach } = await import("../browser-execution.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(conversationId: string): ToolContext {
  return {
    conversationId,
    workingDir: "/tmp",
    trustClass: "guardian",
    signal: new AbortController().signal,
  } as unknown as ToolContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acquireCdpClientWithMode: target_client_id overrides sticky backend mode", () => {
  beforeEach(() => {
    getCdpClientCalls.length = 0;
    getCdpClientMock.mockClear();
    setPreferredBackendKindMock.mockClear();
    clearPreferredBackendKindMock.mockClear();
    stickyKind = null;
  });

  test("sticky local + target_client_id → getCdpClient receives mode:extension, not local", async () => {
    // Simulate a prior turn that pinned the conversation to the local backend.
    stickyKind = "local";

    await executeBrowserAttach(
      { target_client_id: "host-client-abc" },
      makeContext("sticky-local-override"),
    );

    expect(getCdpClientMock).toHaveBeenCalledTimes(1);
    // Fix 1: sticky "local" must be bypassed when target_client_id is present.
    expect(getCdpClientCalls[0].mode).toBe("extension");
    expect(getCdpClientCalls[0].targetClientId).toBe("host-client-abc");
  });

  test("sticky cdp-inspect + target_client_id → getCdpClient receives mode:extension, not cdp-inspect", async () => {
    stickyKind = "cdp-inspect";

    await executeBrowserAttach(
      { target_client_id: "host-client-xyz" },
      makeContext("sticky-inspect-override"),
    );

    expect(getCdpClientMock).toHaveBeenCalledTimes(1);
    expect(getCdpClientCalls[0].mode).toBe("extension");
    expect(getCdpClientCalls[0].targetClientId).toBe("host-client-xyz");
  });

  test("sticky local + no target_client_id → getCdpClient receives mode:local (sticky honored)", async () => {
    // Without target_client_id, the sticky preference must still apply.
    stickyKind = "local";

    await executeBrowserAttach(
      {}, // no target_client_id
      makeContext("sticky-honored"),
    );

    expect(getCdpClientMock).toHaveBeenCalledTimes(1);
    expect(getCdpClientCalls[0].mode).toBe("local");
    expect(getCdpClientCalls[0].targetClientId).toBeUndefined();
  });

  test("no sticky + target_client_id → getCdpClient receives mode:extension", async () => {
    stickyKind = null; // No prior sticky preference

    await executeBrowserAttach(
      { target_client_id: "host-client-fresh" },
      makeContext("no-sticky-targeted"),
    );

    expect(getCdpClientMock).toHaveBeenCalledTimes(1);
    expect(getCdpClientCalls[0].mode).toBe("extension");
    expect(getCdpClientCalls[0].targetClientId).toBe("host-client-fresh");
  });
});
