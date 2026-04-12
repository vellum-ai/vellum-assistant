import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Fake CdpClient & Factory ─────────────────────────────────────────
//
// This test file validates browser_mode parsing and mode-selection
// failure formatting in browser-execution.ts. The factory mock
// intercepts getCdpClient calls and can be configured to throw
// CdpError for pinned-mode precondition failures.

import { CdpError } from "../tools/browser/cdp-client/errors.js";
import type { AttemptDiagnostic } from "../tools/browser/cdp-client/types.js";

let cdpSendCalls: Array<{ method: string; params?: unknown }> = [];
let cdpSendHandler: (
  method: string,
  params?: Record<string, unknown>,
) => unknown = () => ({});
let _cdpDisposed = false;

/** Configure the factory to throw on getCdpClient for pinned modes. */
let factoryThrowError: CdpError | null = null;

function makeFakeCdp(
  kind: "local" | "extension" | "cdp-inspect",
  conversationId: string,
) {
  return {
    kind,
    conversationId,
    async send<T>(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      cdpSendCalls.push({ method, params });
      const value = cdpSendHandler(method, params);
      return (await value) as T;
    },
    dispose() {
      _cdpDisposed = true;
    },
  };
}

mock.module("../tools/browser/cdp-client/factory.js", () => ({
  getCdpClient: (
    context: { hostBrowserProxy?: unknown; conversationId: string },
    options?: { mode?: string },
  ) => {
    if (factoryThrowError) {
      throw factoryThrowError;
    }
    const mode = options?.mode ?? "auto";
    const kind =
      mode === "extension"
        ? "extension"
        : mode === "cdp-inspect"
          ? "cdp-inspect"
          : mode === "local"
            ? "local"
            : context.hostBrowserProxy
              ? "extension"
              : "local";
    return makeFakeCdp(kind, context.conversationId);
  },
}));

// ── Minimal browserManager stub ──────────────────────────────────────

mock.module("../tools/browser/browser-manager.js", () => {
  return {
    browserManager: {
      getOrCreateSessionPage: mock(async () => ({
        url: () => "https://example.com/",
        route: mock(async () => {}),
        unroute: mock(async () => {}),
        close: async () => {},
        isClosed: () => false,
      })),
      clearSnapshotBackendNodeMap: mock(() => {}),
      storeSnapshotBackendNodeMap: mock(() => {}),
      resolveSnapshotBackendNodeId: () => null,
      supportsRouteInterception: false,
      isInteractive: () => false,
      positionWindowSidebar: mock(async () => {}),
    },
  };
});

mock.module("../tools/browser/browser-screencast.js", () => ({
  ensureScreencast: async () => {},
  getSender: () => null,
  stopAllScreencasts: async () => {},
  stopBrowserScreencast: async () => {},
}));

mock.module("../tools/browser/auth-detector.js", () => ({
  detectAuthChallenge: async () => null,
  detectCaptchaChallenge: async () => null,
  formatAuthChallenge: () => "",
}));

// Default url-safety: allow everything
mock.module("../tools/network/url-safety.js", () => ({
  parseUrl: (input: unknown) => {
    if (typeof input === "string" && input.startsWith("http")) {
      try {
        return new URL(input);
      } catch {
        return null;
      }
    }
    return null;
  },
  isPrivateOrLocalHost: () => false,
  resolveHostAddresses: async () => [],
  resolveRequestAddress: async () => ({}),
  sanitizeUrlForOutput: (url: URL) => url.href,
}));

import {
  executeBrowserClick,
  executeBrowserNavigate,
  executeBrowserScreenshot,
  executeBrowserSnapshot,
  formatModeSelectionFailure,
  parseBrowserMode,
} from "../tools/browser/browser-execution.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  conversationId: "test-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
};

/**
 * Default CDP handler that returns sensible defaults for the methods
 * used by navigate and snapshot tools.
 */
function defaultCdpHandler(
  method: string,
  params?: Record<string, unknown>,
): unknown {
  if (method === "Page.navigate") return { frameId: "f1" };
  if (method === "Runtime.evaluate") {
    const expression = String(params?.["expression"] ?? "");
    if (expression === "document.location.href") {
      return { result: { value: "about:blank" } };
    }
    if (expression === "document.title") {
      return { result: { value: "Example" } };
    }
    if (
      expression.includes("readyState") &&
      expression.includes("document.location.href")
    ) {
      return {
        result: {
          value: {
            readyState: "complete",
            href: "https://example.com/page",
          },
        },
      };
    }
    return { result: { value: null } };
  }
  if (method === "Accessibility.enable") return {};
  if (method === "Accessibility.getFullAXTree") {
    return { nodes: [] };
  }
  if (method === "Page.captureScreenshot") {
    return { data: "dGVzdA==" }; // base64 "test"
  }
  return {};
}

function resetCdp() {
  cdpSendCalls = [];
  _cdpDisposed = false;
  cdpSendHandler = defaultCdpHandler;
  factoryThrowError = null;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("parseBrowserMode", () => {
  test("returns auto for missing/empty browser_mode", () => {
    expect(parseBrowserMode({})).toEqual({ ok: true, mode: "auto" });
    expect(parseBrowserMode({ browser_mode: undefined })).toEqual({
      ok: true,
      mode: "auto",
    });
    expect(parseBrowserMode({ browser_mode: null })).toEqual({
      ok: true,
      mode: "auto",
    });
    expect(parseBrowserMode({ browser_mode: "" })).toEqual({
      ok: true,
      mode: "auto",
    });
  });

  test("normalizes canonical values", () => {
    expect(parseBrowserMode({ browser_mode: "extension" })).toEqual({
      ok: true,
      mode: "extension",
    });
    expect(parseBrowserMode({ browser_mode: "cdp-inspect" })).toEqual({
      ok: true,
      mode: "cdp-inspect",
    });
    expect(parseBrowserMode({ browser_mode: "local" })).toEqual({
      ok: true,
      mode: "local",
    });
    expect(parseBrowserMode({ browser_mode: "auto" })).toEqual({
      ok: true,
      mode: "auto",
    });
  });

  test("normalizes cdp-debugger alias to cdp-inspect", () => {
    expect(parseBrowserMode({ browser_mode: "cdp-debugger" })).toEqual({
      ok: true,
      mode: "cdp-inspect",
    });
  });

  test("normalizes playwright alias to local", () => {
    expect(parseBrowserMode({ browser_mode: "playwright" })).toEqual({
      ok: true,
      mode: "local",
    });
  });

  test("returns error for invalid values", () => {
    const result = parseBrowserMode({ browser_mode: "invalid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid browser_mode "invalid"');
      expect(result.error).toContain("Accepted values:");
    }
  });
});

describe("formatModeSelectionFailure", () => {
  test("renders requested mode, attempted backends, and remediation", () => {
    const diagnostics: AttemptDiagnostic[] = [
      {
        candidateKind: "extension",
        inclusionReason: "pinned mode: extension",
        stage: "candidate_selection",
        errorCode: "transport_error",
        errorMessage: "host browser proxy exists but is not connected",
      },
    ];

    const error = new CdpError(
      "transport_error",
      'Pinned mode "extension" unavailable: host browser proxy exists but is not connected',
      { attemptDiagnostics: diagnostics },
    );

    const formatted = formatModeSelectionFailure("extension", error);

    expect(formatted).toContain('Browser mode "extension" failed');
    expect(formatted).toContain("extension: FAILED at candidate_selection");
    expect(formatted).toContain(
      "host browser proxy exists but is not connected",
    );
    expect(formatted).toContain("Remediation:");
    expect(formatted).toContain("extension is installed and enabled");
  });

  test("renders cdp-inspect transport_error with remediation", () => {
    const diagnostics: AttemptDiagnostic[] = [
      {
        candidateKind: "cdp-inspect",
        inclusionReason: "pinned mode: cdp-inspect",
        stage: "send",
        errorCode: "transport_error",
        errorMessage: "CDP endpoint unreachable",
        discoveryCode: "unreachable",
      },
    ];

    const error = new CdpError("transport_error", "CDP endpoint unreachable", {
      attemptDiagnostics: diagnostics,
    });

    const formatted = formatModeSelectionFailure("cdp-inspect", error);

    expect(formatted).toContain('Browser mode "cdp-inspect" failed');
    expect(formatted).toContain("cdp-inspect: FAILED at send");
    expect(formatted).toContain("Discovery code: unreachable");
    expect(formatted).toContain("Remediation:");
    expect(formatted).toContain("--remote-debugging-port");
  });
});

describe("browser_mode wiring through tool execution", () => {
  beforeEach(() => {
    resetCdp();
  });

  // ── Invalid browser_mode returns error ─────────────────────────

  test("executeBrowserNavigate rejects invalid browser_mode", async () => {
    const result = await executeBrowserNavigate(
      { url: "https://example.com", browser_mode: "bogus" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid browser_mode "bogus"');
    expect(cdpSendCalls).toEqual([]);
  });

  test("executeBrowserSnapshot rejects invalid browser_mode", async () => {
    const result = await executeBrowserSnapshot({ browser_mode: "bogus" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid browser_mode "bogus"');
    expect(cdpSendCalls).toEqual([]);
  });

  test("executeBrowserScreenshot rejects invalid browser_mode", async () => {
    const result = await executeBrowserScreenshot(
      { browser_mode: "bogus" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid browser_mode "bogus"');
    expect(cdpSendCalls).toEqual([]);
  });

  // ── Pinned extension with no proxy returns remediation error ───

  test("pinned extension with no proxy returns remediation-rich error in navigate", async () => {
    factoryThrowError = new CdpError(
      "transport_error",
      'Pinned mode "extension" unavailable: no host browser proxy provisioned for this conversation',
      {
        attemptDiagnostics: [
          {
            candidateKind: "extension",
            inclusionReason: "pinned mode: extension",
            stage: "candidate_selection",
            errorCode: "transport_error",
            errorMessage:
              "no host browser proxy provisioned for this conversation",
          },
        ],
      },
    );

    const result = await executeBrowserNavigate(
      { url: "https://example.com", browser_mode: "extension" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Browser mode "extension" failed');
    expect(result.content).toContain(
      "extension: FAILED at candidate_selection",
    );
    expect(result.content).toContain("Remediation:");
    expect(result.content).toContain("extension is installed and enabled");
    // Factory should not have been called for CDP
    expect(cdpSendCalls).toEqual([]);
  });

  test("pinned extension failure surfaces in snapshot tool response", async () => {
    factoryThrowError = new CdpError(
      "transport_error",
      'Pinned mode "extension" unavailable: host browser proxy exists but is not connected',
      {
        attemptDiagnostics: [
          {
            candidateKind: "extension",
            inclusionReason: "pinned mode: extension",
            stage: "candidate_selection",
            errorCode: "transport_error",
            errorMessage: "host browser proxy exists but is not connected",
          },
        ],
      },
    );

    const result = await executeBrowserSnapshot(
      { browser_mode: "extension" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Browser mode "extension" failed');
    expect(result.content).toContain("Remediation:");
  });

  // ── cdp-debugger alias normalization ──────────────────────────

  test("cdp-debugger alias normalizes to cdp-inspect and surfaces failure", async () => {
    factoryThrowError = new CdpError(
      "transport_error",
      "CDP endpoint unreachable",
      {
        attemptDiagnostics: [
          {
            candidateKind: "cdp-inspect",
            inclusionReason: "pinned mode: cdp-inspect",
            stage: "send",
            errorCode: "transport_error",
            errorMessage: "CDP endpoint unreachable on localhost:9222",
            discoveryCode: "unreachable",
          },
        ],
      },
    );

    const result = await executeBrowserSnapshot(
      { browser_mode: "cdp-debugger" },
      ctx,
    );
    expect(result.isError).toBe(true);
    // The error should reference the canonical cdp-inspect name
    expect(result.content).toContain('Browser mode "cdp-inspect" failed');
    expect(result.content).toContain("Discovery code: unreachable");
    expect(result.content).toContain("Remediation:");
    expect(result.content).toContain("--remote-debugging-port");
  });

  // ── Pinned local/playwright behavior ──────────────────────────

  test("pinned local mode proceeds normally on success", async () => {
    // No factory error — local mode succeeds
    const result = await executeBrowserSnapshot({ browser_mode: "local" }, ctx);
    // Snapshot should succeed (using default CDP handler)
    expect(result.isError).toBe(false);
  });

  test("playwright alias maps to local and works", async () => {
    const result = await executeBrowserSnapshot(
      { browser_mode: "playwright" },
      ctx,
    );
    expect(result.isError).toBe(false);
  });

  // ── Auto mode still works without browser_mode ────────────────

  test("auto mode works when browser_mode is not specified", async () => {
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(false);
  });

  // ── Tool-response includes full attempted-mode diagnostics ────

  test("screenshot tool response includes full diagnostics on pinned mode failure", async () => {
    factoryThrowError = new CdpError(
      "transport_error",
      "CDP endpoint unreachable",
      {
        attemptDiagnostics: [
          {
            candidateKind: "cdp-inspect",
            inclusionReason: "pinned mode: cdp-inspect",
            stage: "send",
            errorCode: "transport_error",
            errorMessage: "HTTP discovery failed (unreachable)",
            discoveryCode: "unreachable",
          },
        ],
      },
    );

    const result = await executeBrowserScreenshot(
      { browser_mode: "cdp-inspect" },
      ctx,
    );
    expect(result.isError).toBe(true);

    // Verify the full diagnostic trace is in the response
    expect(result.content).toContain('Browser mode "cdp-inspect" failed');
    expect(result.content).toContain("Attempted backends:");
    expect(result.content).toContain("cdp-inspect: FAILED at send");
    expect(result.content).toContain(
      "Reason: HTTP discovery failed (unreachable)",
    );
    expect(result.content).toContain("Discovery code: unreachable");
    expect(result.content).toContain("Remediation:");
  });

  test("click tool returns remediation error on pinned mode failure", async () => {
    factoryThrowError = new CdpError(
      "transport_error",
      'Pinned mode "extension" unavailable',
      {
        attemptDiagnostics: [
          {
            candidateKind: "extension",
            inclusionReason: "pinned mode: extension",
            stage: "candidate_selection",
            errorCode: "transport_error",
            errorMessage: "no host browser proxy provisioned",
          },
        ],
      },
    );

    // Use selector (not element_id) so resolveElement succeeds and
    // execution reaches acquireCdpClientWithMode where the factory
    // throws the pinned-mode CdpError.
    const result = await executeBrowserClick(
      { selector: "#btn", browser_mode: "extension" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Browser mode "extension" failed');
    expect(result.content).toContain(
      "extension: FAILED at candidate_selection",
    );
    expect(result.content).toContain("Remediation:");
  });
});
