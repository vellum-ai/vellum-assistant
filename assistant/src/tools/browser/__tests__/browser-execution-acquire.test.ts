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

import { createMockLoggerModule } from "../../../__tests__/helpers/mock-logger.js";
import type { ToolContext } from "../../types.js";
import { CdpError } from "../cdp-client/errors.js";
import type { CdpClientKind, InternalBrowserMode } from "../cdp-client/types.js";

// ---------------------------------------------------------------------------
// Captured call state
// ---------------------------------------------------------------------------

interface CdpClientCallOpts {
  mode?: InternalBrowserMode;
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

mock.module("../../../util/logger.js", () => createMockLoggerModule());

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

  test("sticky host-bridge + no target_client_id → getCdpClient receives mode:host-bridge", async () => {
    // A prior turn succeeded on the desktop SSE bridge; the memo holds the
    // internal-only "host-bridge" kind and must round-trip through the
    // factory's pinned path.
    stickyKind = "host-bridge";

    await executeBrowserAttach({}, makeContext("sticky-bridge-honored"));

    expect(getCdpClientMock).toHaveBeenCalledTimes(1);
    expect(getCdpClientCalls[0].mode).toBe("host-bridge");
  });

  test("sticky host-bridge + target_client_id → getCdpClient receives mode:extension", async () => {
    stickyKind = "host-bridge";

    await executeBrowserAttach(
      { target_client_id: "host-client-bridge" },
      makeContext("sticky-bridge-override"),
    );

    expect(getCdpClientMock).toHaveBeenCalledTimes(1);
    expect(getCdpClientCalls[0].mode).toBe("extension");
    expect(getCdpClientCalls[0].targetClientId).toBe("host-client-bridge");
  });

  test("sticky host-bridge gone → memo cleared and auto retry runs", async () => {
    // The pinned host-bridge build throws (bridge disconnected or an
    // extension connected since the memo was written); the acquire layer
    // must clear the stale memo and retry with fresh auto selection.
    stickyKind = "host-bridge";
    getCdpClientMock.mockImplementationOnce(() => {
      getCdpClientCalls.push({ mode: "host-bridge" });
      throw new CdpError(
        "transport_error",
        'Pinned mode "host-bridge" unavailable: a Chrome Extension is now connected',
      );
    });

    await executeBrowserAttach({}, makeContext("sticky-bridge-fallback"));

    expect(getCdpClientMock).toHaveBeenCalledTimes(2);
    expect(getCdpClientCalls[0].mode).toBe("host-bridge");
    expect(getCdpClientCalls[1].mode).toBe("auto");
    expect(clearPreferredBackendKindMock).toHaveBeenCalledTimes(1);
  });
});
