import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the tool under test.
// ---------------------------------------------------------------------------

const mockWakeAgentForOpportunity = mock(() => Promise.resolve());

mock.module("../../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: mockWakeAgentForOpportunity,
}));

// Capture every broadcastMessage call so tests can assert lifecycle events.
type Broadcast = Record<string, unknown> & { type: string };
const broadcasts: Broadcast[] = [];
const mockBroadcastMessage = mock((msg: Broadcast) => {
  broadcasts.push(msg);
});

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    listClientsByCapability: () => [],
  },
  broadcastMessage: mockBroadcastMessage,
}));

type RegisteredTool = {
  id: string;
  toolName: string;
  conversationId: string;
  command: string;
  startedAt: number;
  cancel: (reason?: string) => void;
};

let latestRegistered: RegisteredTool | undefined;
const mockRegisterBackgroundTool = mock((entry: RegisteredTool) => {
  latestRegistered = entry;
});
const mockRemoveBackgroundTool = mock(() => {});
let bgIdCounter = 0;
const mockGenerateBackgroundToolId = mock(
  () => `bg-test-${String(++bgIdCounter).padStart(4, "0")}`,
);
const mockIsBackgroundToolLimitReached = mock(() => false);

mock.module("../background-tool-registry.js", () => ({
  registerBackgroundTool: mockRegisterBackgroundTool,
  removeBackgroundTool: mockRemoveBackgroundTool,
  recordCompletedBackgroundTool: () => {},
  generateBackgroundToolId: mockGenerateBackgroundToolId,
  isBackgroundToolLimitReached: mockIsBackgroundToolLimitReached,
  MAX_BACKGROUND_TOOLS: 20,
}));

// Stub child_process.spawn so we don't actually run commands. The test
// creates a fake ChildProcess (EventEmitter) and drives it manually.
type FakeChild = EventEmitter & {
  pid: number | undefined;
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
  secretDetection: { enabled: true },
  auditLog: { retentionDays: 0 },
};

mock.module("../../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock HostBashProxy singleton — proxy delegation tests configure this.
let mockProxyAvailable = false;
let mockProxyRequestImpl: (
  input: { command: string },
  conversationId: string,
  signal?: AbortSignal,
) => Promise<ToolExecutionResult> = () =>
  Promise.resolve({ content: "", isError: false });

mock.module("../../daemon/host-bash-proxy.js", () => ({
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

import type { ToolContext, ToolExecutionResult } from "../types.js";
import { hostShellTool } from "./host-shell.js";

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

const flush = () => new Promise((r) => setTimeout(r, 10));

function startedEvents(): Broadcast[] {
  return broadcasts.filter((b) => b.type === "background_tool_started");
}

function completedEvents(): Broadcast[] {
  return broadcasts.filter((b) => b.type === "background_tool_completed");
}

/** Controllable promise so cancel can fire before the proxy resolves. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  bgIdCounter = 0;
  broadcasts.length = 0;
  latestRegistered = undefined;
  mockWakeAgentForOpportunity.mockClear();
  mockBroadcastMessage.mockClear();
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

describe("host_bash background lifecycle events — proxy path", () => {
  test("broadcasts started then completed on success", async () => {
    mockProxyAvailable = true;
    mockProxyRequestImpl = () =>
      Promise.resolve({ content: "proxy output", isError: false });

    await hostShellTool.execute(
      { command: "echo bg-proxy", background: true },
      makeContext(),
    );
    await flush();

    const started = startedEvents();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: "background_tool_started",
      id: "bg-test-0001",
      toolName: "host_bash",
      conversationId: "conv-xyz",
      command: "echo bg-proxy",
    });
    expect(typeof started[0]!.startedAt).toBe("number");

    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "background_tool_completed",
      id: "bg-test-0001",
      conversationId: "conv-xyz",
      status: "completed",
      output: "proxy output",
    });
    expect(typeof completed[0]!.completedAt).toBe("number");
  });

  test("completed status is failed on proxy error result", async () => {
    mockProxyAvailable = true;
    mockProxyRequestImpl = () =>
      Promise.resolve({ content: "command not found", isError: true });

    await hostShellTool.execute(
      { command: "bad-command", background: true },
      makeContext(),
    );
    await flush();

    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      status: "failed",
      output: "command not found",
    });
  });

  test("completed status is failed on proxy rejection", async () => {
    mockProxyAvailable = true;
    mockProxyRequestImpl = () =>
      Promise.reject(new Error("proxy transport error"));

    await hostShellTool.execute(
      { command: "echo fail", background: true },
      makeContext(),
    );
    await flush();

    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "failed" });
    expect(completed[0]!.output).toContain("proxy transport error");
  });

  test("cancelling an in-flight proxy command reports cancelled", async () => {
    mockProxyAvailable = true;
    const d = deferred<ToolExecutionResult>();
    // request() swallows the aborted rejection and resolves with an "Aborted"
    // result; the tripped signal is what marks the command as cancelled.
    mockProxyRequestImpl = () => d.promise;

    await hostShellTool.execute(
      { command: "sleep 100", background: true },
      makeContext(),
    );

    // started fired synchronously; not yet completed.
    expect(startedEvents()).toHaveLength(1);
    expect(completedEvents()).toHaveLength(0);

    // Cancel via the registry callback, then let request() resolve.
    expect(latestRegistered).toBeDefined();
    latestRegistered!.cancel("user cancelled");
    d.resolve({ content: "Aborted", isError: true });
    await flush();

    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "cancelled" });
    // Cancellation must surface a cancellation message, not "failed" framing.
    expect(completed[0]!.output).toContain("cancelled");
    expect(completed[0]!.output).not.toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// Direct execution path — background: true
// ---------------------------------------------------------------------------

describe("host_bash background lifecycle events — direct spawn path", () => {
  test("broadcasts started then completed on clean exit", async () => {
    await hostShellTool.execute(
      { command: "echo bg-local", background: true },
      makeContext(),
    );

    const started = startedEvents();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: "background_tool_started",
      id: "bg-test-0001",
      toolName: "host_bash",
      conversationId: "conv-xyz",
      command: "echo bg-local",
    });

    expect(latestChild).toBeDefined();
    latestChild!.stdout.emit("data", Buffer.from("hello world\n"));
    latestChild!.emit("close", 0);
    await flush();

    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "background_tool_completed",
      id: "bg-test-0001",
      status: "completed",
      exitCode: 0,
    });
    expect(completed[0]!.output).toContain("hello world");
  });

  test("completed status is failed on non-zero exit", async () => {
    await hostShellTool.execute(
      { command: "false", background: true },
      makeContext(),
    );

    latestChild!.stderr.emit("data", Buffer.from("boom\n"));
    latestChild!.emit("close", 1);
    await flush();

    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "failed", exitCode: 1 });
  });

  test("completed status is failed on spawn error", async () => {
    await hostShellTool.execute(
      { command: "echo bg-error", background: true },
      makeContext(),
    );

    latestChild!.emit("error", new Error("spawn ENOENT"));
    await flush();

    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "failed" });
    expect(completed[0]!.output).toContain("spawn ENOENT");
  });

  test("cancelling a direct background command reports cancelled", async () => {
    await hostShellTool.execute(
      { command: "sleep 100", background: true },
      makeContext(),
    );

    expect(startedEvents()).toHaveLength(1);
    expect(latestRegistered).toBeDefined();

    // Avoid signalling a real process group; force the child.kill() fallback.
    latestChild!.pid = undefined;
    latestRegistered!.cancel("user cancelled");
    // A cancel SIGKILLs the child, which then closes with a null exit code.
    latestChild!.emit("close", null);
    await flush();

    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "cancelled" });
    // Cancellation must surface a cancellation message, not "failed" framing.
    expect(completed[0]!.output).toContain("cancelled");
    expect(completed[0]!.output).not.toContain("failed");
  });
});
