/**
 * Verifies the structured logs added to the `bash` tool by the
 * subprocess-orphan observability change:
 *
 *   1. Every invocation emits a `"Shell command exited"` info log with
 *      `command`, `mode`, `durationMs`, `exitCode`, `signal`, `timedOut`.
 *   2. Every group-SIGKILL (timeout / abort) emits a `"Shell process
 *      group SIGKILL'd"` warn log with `reason` so post-mortems can map
 *      orphans back to the call site that orphaned them.
 *
 * These logs are the only ground-truth signal that lets the daemon
 * trace zombie accumulation back to a specific shell command — the
 * tests pin them in place so a future refactor can't quietly drop them.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { WakeOptions } from "../runtime/agent-wake.js";
import type { BackgroundTool } from "../tools/background-tool-registry.js";

// ── Mock modules ────────────────────────────────────────────────────────────

interface LogCall {
  level: "info" | "warn" | "debug" | "error";
  fields: Record<string, unknown>;
  msg: string;
}
const logCalls: LogCall[] = [];

function recordLog(level: LogCall["level"]) {
  return (fields: Record<string, unknown> | string, msg?: string) => {
    if (typeof fields === "string") {
      logCalls.push({ level, fields: {}, msg: fields });
    } else {
      logCalls.push({ level, fields, msg: msg ?? "" });
    }
  };
}

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: recordLog("info"),
    warn: recordLog("warn"),
    debug: recordLog("debug"),
    error: recordLog("error"),
  }),
}));

mock.module("../tools/network/script-proxy/index.js", () => ({
  getOrStartSession: mock(() =>
    Promise.resolve({ session: { id: "mock-session" } }),
  ),
  getSessionEnv: mock(() => ({})),
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

mock.module("../tools/background-tool-registry.js", () => ({
  registerBackgroundTool: (tool: BackgroundTool) => {
    registeredTools.push(tool);
  },
  removeBackgroundTool: (id: string) => {
    const idx = registeredTools.findIndex((t) => t.id === id);
    if (idx !== -1) registeredTools.splice(idx, 1);
  },
  recordCompletedBackgroundTool: () => {},
  generateBackgroundToolId: () => "bg-obs-test",
  isBackgroundToolLimitReached: () => false,
  MAX_BACKGROUND_TOOLS: 20,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

// `shellTool` is imported dynamically inside `beforeEach` so the logger
// mock above lands before shell.ts evaluates and captures its `getLogger`
// reference — static imports hoist past `mock.module()` and the test
// would see the real pino logger instead of the in-memory `logCalls`
// array. The shape type below mirrors the satisfies-narrowed export so
// `shellTool.execute(...)` keeps its required-execute typing without a
// `!` bang.
let shellTool: (typeof import("../tools/terminal/shell.js"))["shellTool"];

const baseContext = {
  workingDir: process.env.VELLUM_WORKSPACE_DIR ?? "/tmp",
  conversationId: "conv-obs-test",
  trustClass: "guardian" as const,
  onOutput: () => {},
};

type LogPredicate = (call: LogCall) => boolean;

function findLog(predicate: LogPredicate): LogCall | undefined {
  return logCalls.find(predicate);
}

function waitForLog(
  predicate: LogPredicate,
  label: string,
  timeoutMs = 5_000,
): Promise<LogCall> {
  return new Promise<LogCall>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      timeoutMs,
    );
    const check = () => {
      const hit = findLog(predicate);
      if (hit) {
        clearTimeout(timer);
        return resolve(hit);
      }
      setTimeout(check, 25);
    };
    check();
  });
}

const isExit = (mode: "foreground" | "background") => (c: LogCall) =>
  c.level === "info" &&
  c.msg === "Shell command exited" &&
  c.fields.mode === mode;

const isKill = (reason: string) => (c: LogCall) =>
  c.level === "warn" &&
  c.msg.startsWith("Shell process group SIGKILL") &&
  c.fields.reason === reason;

describe("shell observability logs", () => {
  beforeEach(async () => {
    logCalls.length = 0;
    registeredTools.length = 0;
    const mod = await import("../tools/terminal/shell.js");
    shellTool = mod.shellTool;
  });

  afterEach(() => {
    logCalls.length = 0;
    registeredTools.length = 0;
  });

  test("foreground exit emits structured 'Shell command exited' info log", async () => {
    const result = await shellTool.execute(
      { command: "echo obs-foreground", activity: "test" },
      baseContext,
    );
    expect(result.isError).toBe(false);

    const exit = findLog(isExit("foreground"));
    expect(exit).toBeDefined();
    expect(exit!.fields.exitCode).toBe(0);
    expect(exit!.fields.signal).toBeNull();
    expect(exit!.fields.timedOut).toBe(false);
    expect(exit!.fields.conversationId).toBe("conv-obs-test");
    expect(exit!.fields.command).toBe("echo obs-foreground");
    expect(typeof exit!.fields.durationMs).toBe("number");
  });

  test("foreground timeout emits killTree warn + exit log with timedOut=true", async () => {
    const result = await shellTool.execute(
      { command: "sleep 30", activity: "test", timeout_seconds: 1 },
      baseContext,
    );
    expect(result.isError).toBe(true);

    const kill = findLog(isKill("timeout"));
    expect(kill).toBeDefined();
    expect(kill!.fields.command).toBe("sleep 30");
    expect(kill!.fields.conversationId).toBe("conv-obs-test");
    expect(typeof kill!.fields.groupPid).toBe("number");

    const exit = findLog(
      (c) => isExit("foreground")(c) && c.fields.timedOut === true,
    );
    expect(exit).toBeDefined();
  }, 10_000);

  test("background mode emits an exit log with mode='background' and the bg invocationId", async () => {
    await shellTool.execute(
      { command: "echo bg-obs", activity: "test", background: true },
      baseContext,
    );

    const exit = await waitForLog(
      (c) => isExit("background")(c) && c.fields.invocationId === "bg-obs-test",
      "background exit log",
    );
    expect(exit.fields.exitCode).toBe(0);
    expect(exit.fields.timedOut).toBe(false);
  });

  test("aborted foreground command emits killTree warn with reason='abort'", async () => {
    const controller = new AbortController();
    const execPromise = shellTool.execute(
      { command: "sleep 30", activity: "test" },
      { ...baseContext, signal: controller.signal },
    );

    // Abort once the child has been spawned. A microtask is enough; we
    // poll the log buffer up to 2 s for the warn so the test isn't
    // sensitive to scheduler jitter.
    setTimeout(() => controller.abort(), 50);

    await execPromise;

    const kill = await waitForLog(isKill("abort"), "abort kill log", 2_000);
    expect(kill.fields.command).toBe("sleep 30");
  });
});
