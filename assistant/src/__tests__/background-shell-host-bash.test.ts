import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the tool under test.
// ---------------------------------------------------------------------------

const mockWakeAgentForOpportunity = mock(() => Promise.resolve());

mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: mockWakeAgentForOpportunity,
}));

const mockRegisterBackgroundTool = mock(() => {});
const mockRemoveBackgroundTool = mock(() => {});
let bgIdCounter = 0;
const mockGenerateBackgroundToolId = mock(
  () => `bg-test-${String(++bgIdCounter).padStart(4, "0")}`,
);

const mockIsBackgroundToolLimitReached = mock(() => false);

mock.module("../tools/background-tool-registry.js", () => ({
  registerBackgroundTool: mockRegisterBackgroundTool,
  removeBackgroundTool: mockRemoveBackgroundTool,
  generateBackgroundToolId: mockGenerateBackgroundToolId,
  isBackgroundToolLimitReached: mockIsBackgroundToolLimitReached,
  MAX_BACKGROUND_TOOLS: 20,
}));

// Stub child_process.spawn so we don't actually run commands. The test
// creates a fake ChildProcess (EventEmitter) and drives it manually.
type FakeChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof mock>;
};

let latestChild: FakeChild | undefined;

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = mock(() => {});
  latestChild = child;
  return child;
}

mock.module("node:child_process", () => ({
  spawn: mock(() => makeFakeChild()),
}));

const mockConfig = {
  provider: "anthropic",
  model: "test",
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: {
    enabled: true,
  },
  auditLog: { retentionDays: 0 },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock HostBashProxy singleton — proxy delegation tests configure this.
let mockProxyAvailable = false;
let mockProxyRequestImpl: (
  input: {
    command: string;
    working_dir?: string;
    timeout_seconds?: number;
    env?: Record<string, string>;
  },
  conversationId: string,
  signal?: AbortSignal,
) => Promise<ToolExecutionResult> = () =>
  Promise.resolve({ content: "", isError: false });

mock.module("../daemon/host-bash-proxy.js", () => ({
  HostBashProxy: {
    get instance() {
      return {
        isAvailable: () => mockProxyAvailable,
        request: (...args: Parameters<typeof mockProxyRequestImpl>) =>
          mockProxyRequestImpl(...args),
      };
    },
  },
}));

// ---------------------------------------------------------------------------
// Import under test — MUST come after mock.module calls.
// ---------------------------------------------------------------------------

import { hostShellTool } from "../tools/host-terminal/host-shell.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-xyz",
    trustClass: "guardian",
    ...overrides,
  };
}

function setupMockProxy(result: ToolExecutionResult) {
  const requestMock = mock(
    (
      _input: {
        command: string;
        working_dir?: string;
        timeout_seconds?: number;
        env?: Record<string, string>;
      },
      _conversationId: string,
      _signal?: AbortSignal,
    ) => Promise.resolve(result),
  );

  mockProxyAvailable = true;
  mockProxyRequestImpl = requestMock;

  return requestMock;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  bgIdCounter = 0;
  mockWakeAgentForOpportunity.mockClear();
  mockRegisterBackgroundTool.mockClear();
  mockRemoveBackgroundTool.mockClear();
  mockGenerateBackgroundToolId.mockClear();
  mockIsBackgroundToolLimitReached.mockClear();
  mockIsBackgroundToolLimitReached.mockReturnValue(false);
  latestChild = undefined;
  mockProxyAvailable = false;
  mockProxyRequestImpl = () => Promise.resolve({ content: "", isError: false });
});

afterEach(() => {
  latestChild = undefined;
  mockProxyAvailable = false;
});

// ---------------------------------------------------------------------------
// Proxy path — background: true
// ---------------------------------------------------------------------------

describe("host_bash background mode — proxy path", () => {
  test("returns immediately with backgrounded response", async () => {
    const proxyResult: ToolExecutionResult = {
      content: "proxy output",
      isError: false,
    };
    setupMockProxy(proxyResult);

    const ctx = makeContext({});

    const result = await hostShellTool.execute(
      { command: "echo bg-proxy", background: true },
      ctx,
    );

    const parsed = JSON.parse(result.content);
    expect(parsed.backgrounded).toBe(true);
    expect(parsed.id).toMatch(/^bg-/);
    expect(result.isError).toBe(false);
  });

  test("registers background tool in the registry", async () => {
    const proxyResult: ToolExecutionResult = {
      content: "proxy output",
      isError: false,
    };
    setupMockProxy(proxyResult);

    const ctx = makeContext({});

    await hostShellTool.execute(
      { command: "echo bg-proxy", background: true },
      ctx,
    );

    expect(mockRegisterBackgroundTool).toHaveBeenCalledTimes(1);
    const registered = (
      mockRegisterBackgroundTool.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(registered.toolName).toBe("host_bash");
    expect(registered.conversationId).toBe("conv-xyz");
    expect(registered.command).toBe("echo bg-proxy");
  });

  test("calls wakeAgentForOpportunity on proxy success", async () => {
    const proxyResult: ToolExecutionResult = {
      content: "proxy success output",
      isError: false,
    };
    setupMockProxy(proxyResult);

    const ctx = makeContext({});

    await hostShellTool.execute(
      { command: "echo bg-proxy", background: true },
      ctx,
    );

    // The proxy resolves immediately in our mock, so the .then() handler runs
    // in the next microtask. Flush microtasks.
    await new Promise((r) => setTimeout(r, 10));

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    const wakeCall = (
      mockWakeAgentForOpportunity.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(wakeCall.conversationId).toBe("conv-xyz");
    expect(wakeCall.hint).toBe(
      "Background host command completed (id=bg-test-0001):\nproxy success output",
    );
    expect(wakeCall.source).toBe("background-tool");
  });

  test("calls wakeAgentForOpportunity on proxy error result", async () => {
    const proxyResult: ToolExecutionResult = {
      content: "command not found",
      isError: true,
    };
    setupMockProxy(proxyResult);

    const ctx = makeContext({});

    await hostShellTool.execute(
      { command: "bad-command", background: true },
      ctx,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    const wakeCall = (
      mockWakeAgentForOpportunity.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(wakeCall.hint).toContain("Background host command failed");
    expect(wakeCall.hint).toContain("command not found");
  });

  test("calls wakeAgentForOpportunity on proxy rejection", async () => {
    mockProxyAvailable = true;
    mockProxyRequestImpl = () =>
      Promise.reject(new Error("proxy transport error"));

    const ctx = makeContext({});

    await hostShellTool.execute(
      { command: "echo fail", background: true },
      ctx,
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    const wakeCall = (
      mockWakeAgentForOpportunity.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(wakeCall.hint).toContain("Background host command failed");
    expect(wakeCall.hint).toContain("proxy transport error");
  });

  test("removes background tool from registry on completion", async () => {
    const proxyResult: ToolExecutionResult = {
      content: "done",
      isError: false,
    };
    setupMockProxy(proxyResult);

    const ctx = makeContext({});

    const result = await hostShellTool.execute(
      { command: "echo bg-proxy", background: true },
      ctx,
    );

    const parsed = JSON.parse(result.content);

    // Flush microtasks
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRemoveBackgroundTool).toHaveBeenCalledTimes(1);
    expect(mockRemoveBackgroundTool).toHaveBeenCalledWith(parsed.id);
  });
});

// ---------------------------------------------------------------------------
// Direct execution path — background: true
// ---------------------------------------------------------------------------

describe("host_bash background mode — direct execution path", () => {
  test("returns immediately with backgrounded response", async () => {
    const ctx = makeContext();

    const result = await hostShellTool.execute(
      { command: "echo bg-local", background: true },
      ctx,
    );

    const parsed = JSON.parse(result.content);
    expect(parsed.backgrounded).toBe(true);
    expect(parsed.id).toMatch(/^bg-/);
    expect(result.isError).toBe(false);
  });

  test("registers background tool in the registry", async () => {
    const ctx = makeContext();

    await hostShellTool.execute(
      { command: "echo bg-local", background: true },
      ctx,
    );

    expect(mockRegisterBackgroundTool).toHaveBeenCalledTimes(1);
    const registered = (
      mockRegisterBackgroundTool.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(registered.toolName).toBe("host_bash");
    expect(registered.conversationId).toBe("conv-xyz");
    expect(registered.command).toBe("echo bg-local");
    expect(typeof registered.cancel).toBe("function");
  });

  test("calls wakeAgentForOpportunity on process exit", async () => {
    const ctx = makeContext();

    await hostShellTool.execute(
      { command: "echo bg-local", background: true },
      ctx,
    );

    expect(latestChild).toBeDefined();

    // Simulate stdout data and process close
    latestChild!.stdout.emit("data", Buffer.from("hello world\n"));
    latestChild!.emit("close", 0);

    // Flush microtasks
    await new Promise((r) => setTimeout(r, 10));

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    const wakeCall = (
      mockWakeAgentForOpportunity.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(wakeCall.conversationId).toBe("conv-xyz");
    expect(wakeCall.source).toBe("background-tool");
    expect(wakeCall.hint).toContain("hello world");
  });

  test("calls wakeAgentForOpportunity with error hint on non-zero exit", async () => {
    const ctx = makeContext();

    await hostShellTool.execute({ command: "false", background: true }, ctx);

    expect(latestChild).toBeDefined();

    latestChild!.stderr.emit("data", Buffer.from("something failed\n"));
    latestChild!.emit("close", 1);

    await new Promise((r) => setTimeout(r, 10));

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    const wakeCall = (
      mockWakeAgentForOpportunity.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(wakeCall.hint).toContain("Background host command failed");
  });

  test("calls wakeAgentForOpportunity on spawn error", async () => {
    const ctx = makeContext();

    await hostShellTool.execute(
      { command: "echo bg-error", background: true },
      ctx,
    );

    expect(latestChild).toBeDefined();

    latestChild!.emit("error", new Error("spawn ENOENT"));

    await new Promise((r) => setTimeout(r, 10));

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    const wakeCall = (
      mockWakeAgentForOpportunity.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(wakeCall.hint).toContain("Background host command failed");
    expect(wakeCall.hint).toContain("spawn ENOENT");
  });

  test("removes background tool from registry on process exit", async () => {
    const ctx = makeContext();

    const result = await hostShellTool.execute(
      { command: "echo bg-local", background: true },
      ctx,
    );

    const parsed = JSON.parse(result.content);

    latestChild!.emit("close", 0);

    await new Promise((r) => setTimeout(r, 10));

    expect(mockRemoveBackgroundTool).toHaveBeenCalledTimes(1);
    expect(mockRemoveBackgroundTool).toHaveBeenCalledWith(parsed.id);
  });

  test("removes background tool from registry on spawn error", async () => {
    const ctx = makeContext();

    const result = await hostShellTool.execute(
      { command: "echo bg-error", background: true },
      ctx,
    );

    const parsed = JSON.parse(result.content);

    latestChild!.emit("error", new Error("spawn ENOENT"));

    await new Promise((r) => setTimeout(r, 10));

    expect(mockRemoveBackgroundTool).toHaveBeenCalledTimes(1);
    expect(mockRemoveBackgroundTool).toHaveBeenCalledWith(parsed.id);
  });
});
