import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { WakeOptions } from "../runtime/agent-wake.js";
import type { BackgroundTool } from "../tools/background-tool-registry.js";

// ── Mock modules ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target: Record<string, unknown>, _prop: string) => () => {},
    }),
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

const mockIsBackgroundToolLimitReached = mock(() => false);

mock.module("../tools/background-tool-registry.js", () => ({
  registerBackgroundTool: mockRegisterBackgroundTool,
  removeBackgroundTool: mockRemoveBackgroundTool,
  recordCompletedBackgroundTool: () => {},
  generateBackgroundToolId: mockGenerateBackgroundToolId,
  isBackgroundToolLimitReached: mockIsBackgroundToolLimitReached,
  MAX_BACKGROUND_TOOLS: 20,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { shellTool } from "../tools/terminal/shell.js";

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
  beforeEach(() => {
    mockWakeAgentForOpportunity.mockClear();
    mockRegisterBackgroundTool.mockClear();
    mockRemoveBackgroundTool.mockClear();
    mockGenerateBackgroundToolId.mockClear();
    mockGenerateBackgroundToolId.mockReturnValue("bg-test1234");
    mockIsBackgroundToolLimitReached.mockClear();
    mockIsBackgroundToolLimitReached.mockReturnValue(false);
    registeredTools.length = 0;
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
    expect(wakeCall.hint).toContain("bg-test1234");
    expect(wakeCall.persistTriggerAsEvent).toBe(true);
    // Command stdout is fenced as untrusted output, not inlined in the hint.
    expect(wakeCall.untrustedOutput?.content).toContain("bg_output_12345");
    expect(wakeCall.untrustedOutput?.source).toBe("tool_result");
    // Durable completion record stamped onto the persisted wake.
    expect(wakeCall.backgroundToolCompletion?.id).toBe("bg-test1234");
    expect(wakeCall.backgroundToolCompletion?.status).toBe("completed");
    expect(wakeCall.backgroundToolCompletion?.exitCode).toBe(0);
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
    expect(wakeCall.backgroundToolCompletion?.id).toBe("bg-test1234");
    expect(wakeCall.backgroundToolCompletion?.status).toBe("failed");
    expect(wakeCall.backgroundToolCompletion?.exitCode).toBe(1);
  });

  test("cancelled background process wakes with the cancellation, not a completed result", async () => {
    await shellTool.execute(
      { command: "sleep 30", activity: "test", background: true },
      baseContext,
    );

    // User presses Stop: cancel aborts the run and kills the process.
    const registered = mockRegisterBackgroundTool.mock
      .calls[0]![0] as BackgroundTool;
    registered.cancel();

    await waitForWake(mockWakeAgentForOpportunity);

    const wakeCall = mockWakeAgentForOpportunity.mock
      .calls[0]![0] as WakeOptions;
    // The wake must reflect the cancellation, not the generic "completed"
    // framing + SIGKILL-failed output the assistant used to receive — so it
    // matches the recorded/broadcast status and the inline card.
    expect(wakeCall.hint).toContain("bg-test1234");
    expect(wakeCall.hint).toContain("cancelled");
    expect(wakeCall.hint).not.toContain("completed");
    expect(wakeCall.untrustedOutput?.content).toContain("cancelled");
    expect(wakeCall.backgroundToolCompletion?.id).toBe("bg-test1234");
    expect(wakeCall.backgroundToolCompletion?.status).toBe("cancelled");
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
