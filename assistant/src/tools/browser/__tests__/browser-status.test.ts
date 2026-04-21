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
});
