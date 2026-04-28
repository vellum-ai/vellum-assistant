import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { WakeOptions } from "../runtime/agent-wake.js";
import type { BackgroundTool } from "../tools/background-tool-registry.js";
import type { Tool } from "../tools/types.js";

// ── Mock modules ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target: Record<string, unknown>, _prop: string) => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    timeouts: { shellDefaultTimeoutSec: 120, shellMaxTimeoutSec: 600 },
    sandbox: {
      enabled: false,
      backend: "native",
      docker: {
        image: "vellum-sandbox:latest",
        shell: "bash",
        cpus: 1,
        memoryMb: 512,
        pidsLimit: 256,
        network: "none",
      },
    },
  }),
  loadConfig: () => ({}),
}));

mock.module("../tools/network/script-proxy/index.js", () => ({
  getOrStartSession: mock(() =>
    Promise.resolve({ session: { id: "mock-session" } }),
  ),
  getSessionEnv: mock(() => ({
    HTTP_PROXY: "http://localhost:9999",
    HTTPS_PROXY: "http://localhost:9999",
  })),
  createSession: () => {},
  startSession: () => {},
  stopSession: () => {},
  getActiveSession: () => null,
  getSessionsForConversation: () => [],
  stopAllSessions: () => {},
  ensureLocalCA: () => {},
  ensureCombinedCABundle: () => {},
  issueLeafCert: () => {},
  getCAPath: () => "",
  getCombinedCAPath: () => "",
}));

const mockWakeAgentForOpportunity = mock(
  (
    _opts: WakeOptions,
  ): Promise<{ invoked: boolean; producedToolCalls: boolean }> =>
    Promise.resolve({ invoked: true, producedToolCalls: false }),
);

mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: mockWakeAgentForOpportunity,
}));

const registeredTools: BackgroundTool[] = [];

const mockRegisterBackgroundTool = mock((tool: BackgroundTool) => {
  registeredTools.push(tool);
});
const mockRemoveBackgroundTool = mock((_id: string) => {
  const idx = registeredTools.findIndex((t) => t.id === _id);
  if (idx !== -1) registeredTools.splice(idx, 1);
});
const mockGenerateBackgroundToolId = mock(() => "bg-test1234");

mock.module("../tools/background-tool-registry.js", () => ({
  registerBackgroundTool: mockRegisterBackgroundTool,
  removeBackgroundTool: mockRemoveBackgroundTool,
  generateBackgroundToolId: mockGenerateBackgroundToolId,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

const baseContext = {
  workingDir: process.env.VELLUM_WORKSPACE_DIR ?? "/tmp",
  conversationId: "conv-bg-test",
  trustClass: "guardian" as const,
  onOutput: () => {},
};

/** Poll until `mockFn` has been called at least once (10 s timeout). */
function waitForWake(
  mockFn: ReturnType<typeof mock>,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for wakeAgentForOpportunity")),
      timeoutMs,
    );
    const check = () => {
      if (mockFn.mock.calls.length > 0) {
        clearTimeout(timer);
        return resolve();
      }
      setTimeout(check, 50);
    };
    check();
  });
}

describe("bash tool background mode", () => {
  let shellTool: Tool;

  beforeEach(async () => {
    mockWakeAgentForOpportunity.mockClear();
    mockRegisterBackgroundTool.mockClear();
    mockRemoveBackgroundTool.mockClear();
    mockGenerateBackgroundToolId.mockClear();
    mockGenerateBackgroundToolId.mockReturnValue("bg-test1234");
    registeredTools.length = 0;

    const mod = await import("../tools/terminal/shell.js");
    shellTool = mod.shellTool;
  });

  afterEach(() => {
    registeredTools.length = 0;
  });

  test("background: true returns immediately with backgrounded payload", async () => {
    const result = await shellTool.execute(
      { command: "echo hello", activity: "test", background: true },
      baseContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.backgrounded).toBe(true);
    expect(parsed.id).toBe("bg-test1234");

    // Wait for background process to settle so it doesn't leak into later tests.
    await waitForWake(mockWakeAgentForOpportunity);
  });

  test("background process registers in the background tool registry", async () => {
    await shellTool.execute(
      { command: "echo hello", activity: "test", background: true },
      baseContext,
    );

    expect(mockRegisterBackgroundTool).toHaveBeenCalledTimes(1);
    const registered = mockRegisterBackgroundTool.mock
      .calls[0]![0] as BackgroundTool;
    expect(registered.id).toBe("bg-test1234");
    expect(registered.toolName).toBe("bash");
    expect(registered.conversationId).toBe("conv-bg-test");
    expect(registered.command).toBe("echo hello");
    expect(typeof registered.cancel).toBe("function");

    // Wait for background process to settle so it doesn't leak into later tests.
    await waitForWake(mockWakeAgentForOpportunity);
  });

  test("background process completion triggers wakeAgentForOpportunity with stdout", async () => {
    await shellTool.execute(
      { command: "echo bg_output_12345", activity: "test", background: true },
      baseContext,
    );

    // Wait for the background process to complete and fire the wake.
    await waitForWake(mockWakeAgentForOpportunity);

    expect(mockRemoveBackgroundTool).toHaveBeenCalledWith("bg-test1234");
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);

    const wakeCall = mockWakeAgentForOpportunity.mock
      .calls[0]![0] as WakeOptions;
    expect(wakeCall.conversationId).toBe("conv-bg-test");
    expect(wakeCall.source).toBe("background-tool");
    expect(wakeCall.hint).toContain("bg_output_12345");
    expect(wakeCall.hint).toContain("bg-test1234");
  });

  test("failing background process delivers an error hint via wake", async () => {
    await shellTool.execute(
      { command: "exit 1", activity: "test", background: true },
      baseContext,
    );

    // Wait for the background process to complete.
    await waitForWake(mockWakeAgentForOpportunity);

    expect(mockRemoveBackgroundTool).toHaveBeenCalledWith("bg-test1234");
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);

    const wakeCall = mockWakeAgentForOpportunity.mock
      .calls[0]![0] as WakeOptions;
    expect(wakeCall.conversationId).toBe("conv-bg-test");
    expect(wakeCall.source).toBe("background-tool");
    expect(wakeCall.hint).toContain("bg-test1234");
    // The command fails with exit code 1, so the hint should reflect failure
    expect(wakeCall.hint).toContain("exit=1");
  });

  test("foreground mode still works when background is not set", async () => {
    const result = await shellTool.execute(
      { command: "echo foreground_test_789", activity: "test" },
      baseContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("foreground_test_789");
    // Background registry should not be touched for foreground commands
    expect(mockRegisterBackgroundTool).not.toHaveBeenCalled();
    expect(mockWakeAgentForOpportunity).not.toHaveBeenCalled();
  });
});
