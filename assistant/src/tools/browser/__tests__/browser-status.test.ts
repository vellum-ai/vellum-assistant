import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../../types.js";
import {
  BROWSER_STATUS_INPUT_FIELD,
  BROWSER_STATUS_MODE,
} from "../browser-status-constants.js";
import { CdpError } from "../cdp-client/errors.js";

type ProbeOutcome = "ok" | "fail";

const probeOutcomes: Record<string, ProbeOutcome> = {
  [BROWSER_STATUS_MODE.EXTENSION]: "ok",
  [BROWSER_STATUS_MODE.CDP_INSPECT]: "ok",
  [BROWSER_STATUS_MODE.LOCAL]: "ok",
};
const probeErrors: Record<string, CdpError | null> = {
  [BROWSER_STATUS_MODE.EXTENSION]: null,
  [BROWSER_STATUS_MODE.CDP_INSPECT]: null,
  [BROWSER_STATUS_MODE.LOCAL]: null,
};

const buildCandidateListMock = mock((_context: ToolContext) => [
  { kind: BROWSER_STATUS_MODE.EXTENSION, reason: "mock" },
  { kind: BROWSER_STATUS_MODE.CDP_INSPECT, reason: "mock" },
  { kind: BROWSER_STATUS_MODE.LOCAL, reason: "mock" },
]);

const getCdpClientMock = mock(
  (_context: ToolContext, options?: { mode?: string }) => {
    const mode = (options?.mode ?? "auto") as string;
    const outcome = probeOutcomes[mode];
    return {
      kind: mode,
      conversationId: "test-conversation",
      send: mock(async () => {
        if (outcome === "fail") {
          throw (
            probeErrors[mode] ??
            new CdpError("transport_error", `${mode} probe failed`)
          );
        }
        return { result: { value: "complete" } };
      }),
      dispose: mock(() => {}),
    };
  },
);

mock.module("../cdp-client/factory.js", () => ({
  buildCandidateList: buildCandidateListMock,
  getCdpClient: getCdpClientMock,
  isDesktopAutoCooldownActive: () => false,
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({
    hostBrowser: {
      cdpInspect: {
        enabled: true,
        host: "localhost",
        port: 9222,
        probeTimeoutMs: 500,
        desktopAuto: { enabled: true, cooldownMs: 30_000 },
      },
    },
  }),
}));

mock.module("../runtime-check.js", () => ({
  checkBrowserRuntime: async () => ({
    playwrightAvailable: true,
    chromiumInstalled: true,
    chromiumPath: "/tmp/chromium",
    error: null,
  }),
}));

mock.module("../browser-manager.js", () => ({
  browserManager: {
    getPreferredBackendKind: () => null,
  },
}));

const { executeBrowserStatus } = await import("../browser-execution.js");

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
    ...overrides,
  } as ToolContext;
}

describe("executeBrowserStatus", () => {
  beforeEach(() => {
    probeOutcomes[BROWSER_STATUS_MODE.EXTENSION] = "ok";
    probeOutcomes[BROWSER_STATUS_MODE.CDP_INSPECT] = "ok";
    probeOutcomes[BROWSER_STATUS_MODE.LOCAL] = "ok";
    probeErrors[BROWSER_STATUS_MODE.EXTENSION] = null;
    probeErrors[BROWSER_STATUS_MODE.CDP_INSPECT] = null;
    probeErrors[BROWSER_STATUS_MODE.LOCAL] = null;
  });

  test("reports extension preflight-unavailable when no host browser proxy is bound", async () => {
    const result = await executeBrowserStatus({}, makeContext());
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    const extension = payload.modes.find(
      (m: { mode: string }) => m.mode === BROWSER_STATUS_MODE.EXTENSION,
    );
    expect(extension).toBeDefined();
    expect(extension.available).toBe(false);
    expect(extension.verified).toBe("preflight");
  });

  test("supports mode filtering via browser_mode", async () => {
    const result = await executeBrowserStatus(
      { browser_mode: BROWSER_STATUS_MODE.LOCAL },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    expect(payload.checkedModes).toEqual([BROWSER_STATUS_MODE.LOCAL]);
    expect(payload.modes).toHaveLength(1);
    expect(payload.modes[0].mode).toBe(BROWSER_STATUS_MODE.LOCAL);
  });

  test("validates check_local_launch type", async () => {
    const result = await executeBrowserStatus(
      { [BROWSER_STATUS_INPUT_FIELD.CHECK_LOCAL_LAUNCH]: "yes" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      `${BROWSER_STATUS_INPUT_FIELD.CHECK_LOCAL_LAUNCH} must be a boolean`,
    );
  });

  test("reports extension as connected when probe fails on restricted chrome:// page", async () => {
    probeOutcomes[BROWSER_STATUS_MODE.EXTENSION] = "fail";
    probeErrors[BROWSER_STATUS_MODE.EXTENSION] = new CdpError(
      "cdp_error",
      "Cannot access a chrome:// URL",
    );

    const result = await executeBrowserStatus(
      {},
      makeContext({
        hostBrowserProxy: {
          isAvailable: () => true,
        } as ToolContext["hostBrowserProxy"],
      }),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    const extension = payload.modes.find(
      (m: { mode: string }) => m.mode === BROWSER_STATUS_MODE.EXTENSION,
    );
    expect(extension).toBeDefined();
    expect(extension.available).toBe(true);
    expect(extension.verified).toBe("active_probe");
    expect(extension.details.restrictedActiveTab).toBe(true);
  });

  // ── macOS host-browser proxy mode tests ─────────────────────────────

  test("macOS: reports host browser proxy as available when proxy is bound and connected", async () => {
    const result = await executeBrowserStatus(
      {},
      makeContext({
        transportInterface: "macos",
        hostBrowserProxy: {
          isAvailable: () => true,
        } as ToolContext["hostBrowserProxy"],
      }),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    const extension = payload.modes.find(
      (m: { mode: string }) => m.mode === BROWSER_STATUS_MODE.EXTENSION,
    );
    expect(extension).toBeDefined();
    expect(extension.available).toBe(true);
    expect(extension.verified).toBe("active_probe");
    expect(extension.summary).toContain("macOS host browser proxy");
    expect(extension.details.transport).toBe("macos-sse");
  });

  test("macOS: reports transport as extension-ws when hostBrowserRegistryRouted is true", async () => {
    const result = await executeBrowserStatus(
      {},
      makeContext({
        transportInterface: "macos",
        hostBrowserRegistryRouted: true,
        hostBrowserProxy: {
          isAvailable: () => true,
        } as ToolContext["hostBrowserProxy"],
      }),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    const extension = payload.modes.find(
      (m: { mode: string }) => m.mode === BROWSER_STATUS_MODE.EXTENSION,
    );
    expect(extension).toBeDefined();
    expect(extension.available).toBe(true);
    expect(extension.details.transport).toBe("extension-ws");
  });

  test("macOS: reports proxy unbound with macOS-specific actions when no proxy is present", async () => {
    const result = await executeBrowserStatus(
      {},
      makeContext({
        transportInterface: "macos",
      }),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    const extension = payload.modes.find(
      (m: { mode: string }) => m.mode === BROWSER_STATUS_MODE.EXTENSION,
    );
    expect(extension).toBeDefined();
    expect(extension.available).toBe(false);
    expect(extension.summary).toContain("macOS host browser proxy");
    expect(extension.summary).toContain("desktop client");
    expect(extension.details.transport).toBe("macos-sse");
    // macOS-specific user actions should mention the desktop app, not the extension
    expect(
      extension.userActions.some((a: string) => a.includes("desktop app")),
    ).toBe(true);
  });

  test("macOS: reports proxy disconnected with reconnect actions when proxy is bound but not available", async () => {
    const result = await executeBrowserStatus(
      {},
      makeContext({
        transportInterface: "macos",
        hostBrowserProxy: {
          isAvailable: () => false,
        } as ToolContext["hostBrowserProxy"],
      }),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    const extension = payload.modes.find(
      (m: { mode: string }) => m.mode === BROWSER_STATUS_MODE.EXTENSION,
    );
    expect(extension).toBeDefined();
    expect(extension.available).toBe(false);
    expect(extension.summary).toContain("macOS host browser proxy");
    expect(extension.summary).toContain("SSE transport");
    expect(extension.details.transport).toBe("macos-sse");
    // Should suggest reconnection, not extension install
    expect(
      extension.userActions.some((a: string) => a.includes("desktop app")),
    ).toBe(true);
  });

  test("macOS: probe failure diagnostics include transport-specific remediation", async () => {
    probeOutcomes[BROWSER_STATUS_MODE.EXTENSION] = "fail";
    probeErrors[BROWSER_STATUS_MODE.EXTENSION] = new CdpError(
      "transport_error",
      "transport disconnected before response",
    );

    const result = await executeBrowserStatus(
      {},
      makeContext({
        transportInterface: "macos",
        hostBrowserProxy: {
          isAvailable: () => true,
        } as ToolContext["hostBrowserProxy"],
      }),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    const extension = payload.modes.find(
      (m: { mode: string }) => m.mode === BROWSER_STATUS_MODE.EXTENSION,
    );
    expect(extension).toBeDefined();
    expect(extension.available).toBe(false);
    expect(extension.summary).toContain("macOS host browser proxy");
    // Should have remediation actions mentioning SSE bridge
    expect(
      extension.userActions.some((a: string) => a.includes("SSE bridge")),
    ).toBe(true);
  });

  test("recommendation order follows auto candidate precedence for macOS with available extension proxy", async () => {
    const result = await executeBrowserStatus(
      {},
      makeContext({
        transportInterface: "macos",
        hostBrowserProxy: {
          isAvailable: () => true,
        } as ToolContext["hostBrowserProxy"],
      }),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    // Extension is the top auto candidate and is available, so it should be recommended
    expect(payload.recommendedMode).toBe(BROWSER_STATUS_MODE.EXTENSION);
    expect(payload.autoCandidateOrder[0]).toBe(BROWSER_STATUS_MODE.EXTENSION);
  });

  test("recommendation falls to cdp-inspect when macOS proxy is unavailable", async () => {
    // Extension probe fails
    probeOutcomes[BROWSER_STATUS_MODE.EXTENSION] = "fail";
    probeErrors[BROWSER_STATUS_MODE.EXTENSION] = new CdpError(
      "transport_error",
      "proxy not connected",
    );

    const result = await executeBrowserStatus(
      {},
      makeContext({
        transportInterface: "macos",
        // No proxy bound, so extension unavailable
      }),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    // Extension is unavailable (no proxy), so recommendation should fall to next available
    expect(payload.recommendedMode).toBe(BROWSER_STATUS_MODE.CDP_INSPECT);
  });

  test("macOS: restricted chrome:// page probe includes macOS transport details", async () => {
    probeOutcomes[BROWSER_STATUS_MODE.EXTENSION] = "fail";
    probeErrors[BROWSER_STATUS_MODE.EXTENSION] = new CdpError(
      "cdp_error",
      "Cannot access a chrome:// URL",
    );

    const result = await executeBrowserStatus(
      {},
      makeContext({
        transportInterface: "macos",
        hostBrowserProxy: {
          isAvailable: () => true,
        } as ToolContext["hostBrowserProxy"],
      }),
    );
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    const extension = payload.modes.find(
      (m: { mode: string }) => m.mode === BROWSER_STATUS_MODE.EXTENSION,
    );
    expect(extension).toBeDefined();
    expect(extension.available).toBe(true);
    expect(extension.summary).toContain("macOS host browser proxy");
    expect(extension.details.transport).toBe("macos-sse");
  });
});
