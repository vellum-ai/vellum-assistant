import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../types.js";

// ---------------------------------------------------------------------------
// Singleton mocks — must precede the tool import so bun's module mock applies.
// ---------------------------------------------------------------------------

// Silence the logger across every module this graph reaches.
const realLogger = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const realLoader = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...realLoader,
  getConfig: () =>
    ({
      timeouts: { shellDefaultTimeoutSec: 30, shellMaxTimeoutSec: 60 },
    }) as unknown as ReturnType<typeof realLoader.getConfig>,
}));

const realGates = await import("../../credential-execution/feature-gates.js");
mock.module("../../credential-execution/feature-gates.js", () => ({
  ...realGates,
  isCesShellLockdownEnabled: () => false,
}));

// Capture lifecycle events broadcast by the tool.
type CapturedEvent = { type: string } & Record<string, unknown>;
const events: CapturedEvent[] = [];

const realHub = await import("../../runtime/assistant-event-hub.js");
mock.module("../../runtime/assistant-event-hub.js", () => ({
  ...realHub,
  broadcastMessage: (msg: unknown) => {
    events.push(msg as CapturedEvent);
  },
}));

// Background completion wakes the agent; that side-effect is out of scope here.
const realWake = await import("../../runtime/agent-wake.js");
mock.module("../../runtime/agent-wake.js", () => ({
  ...realWake,
  wakeAgentForOpportunity: async () => ({}),
}));

const { shellTool } = await import("./shell.js");
const { cancelBackgroundTool, _clearRegistryForTesting } =
  await import("../background-tool-registry.js");

function makeContext(): ToolContext {
  return {
    workingDir: process.cwd(),
    conversationId: "conv-1",
    trustClass: "guardian",
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startBackground(command: string): Promise<string> {
  const result = await shellTool.execute(
    { command, activity: "test", background: true },
    makeContext(),
  );
  const parsed = JSON.parse(result.content) as { id: string };
  return parsed.id;
}

function completedEvents(): CapturedEvent[] {
  return events.filter((e) => e.type === "background_tool_completed");
}

describe("background bash lifecycle events", () => {
  beforeEach(() => {
    events.length = 0;
    _clearRegistryForTesting();
  });

  afterEach(() => {
    _clearRegistryForTesting();
  });

  test("normal exit broadcasts one started then one completed", async () => {
    const id = await startBackground("exit 0");

    const started = events.filter((e) => e.type === "background_tool_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      id,
      toolName: "bash",
      conversationId: "conv-1",
      command: "exit 0",
    });
    expect(typeof started[0]?.startedAt).toBe("number");

    await waitFor(() => completedEvents().length > 0);
    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      id,
      conversationId: "conv-1",
      status: "completed",
      exitCode: 0,
    });
  });

  test("non-zero exit broadcasts completed with status failed", async () => {
    const id = await startBackground("exit 3");

    await waitFor(() => completedEvents().length > 0);
    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      id,
      status: "failed",
      exitCode: 3,
    });
  });

  test("timed-out background command broadcasts completed with status failed", async () => {
    // A 1s timeout against a long-running command forces the timeout watcher
    // to SIGKILL the process group (timedOut=true, aborted=false), which must
    // map to "failed" — distinct from a cancel's "cancelled".
    const result = await shellTool.execute(
      {
        command: "sleep 30",
        activity: "test",
        background: true,
        timeout_seconds: 1,
      },
      makeContext(),
    );
    const { id } = JSON.parse(result.content) as { id: string };

    await waitFor(() => completedEvents().length > 0);
    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ id, status: "failed" });
    expect(completed[0]?.exitCode).toBeNull();
    // A timeout is not a cancel: it must not carry the cancellation message.
    expect(completed[0]?.output).not.toContain("cancelled");
  });

  test("cancelled background command broadcasts completed with status cancelled", async () => {
    const id = await startBackground("sleep 30");

    expect(completedEvents()).toHaveLength(0);
    expect(cancelBackgroundTool(id)).toBe(true);

    await waitFor(() => completedEvents().length > 0);
    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ id, status: "cancelled" });
    expect(completed[0]?.exitCode).toBeNull();
    // Cancellation must not surface the "failed exit code null" framing.
    expect(completed[0]?.output).toContain("cancelled");
    expect(completed[0]?.output).not.toContain("failed");
  });
});

describe("foreground stdin handling", () => {
  test("a piped child reading fd 0 succeeds without ENXIO", async () => {
    // Reproduces `producer | assistant <cmd>` run under the shell tool: the
    // consumer's stdin is a real pipe read-end. Reading fd 0 must work;
    // reopening "/dev/stdin" would fail ENXIO on a pipe.
    const readFd0 =
      'const {readFileSync}=require("node:fs");process.stdout.write(readFileSync(0,"utf-8"))';
    const result = await shellTool.execute(
      {
        command: `printf '%s' piped-payload | ${process.execPath} -e '${readFd0}'`,
        activity: "test",
      },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("piped-payload");
    expect(result.content).not.toContain("ENXIO");
  });

  test("top-level command sees EOF-clean stdin (ignored, not closed)", async () => {
    // The shell tool wires stdin to /dev/null via `stdio: ["ignore", ...]`,
    // so a well-behaved child reading stdin gets immediate EOF, never ENXIO.
    const result = await shellTool.execute(
      { command: "cat; echo done", activity: "test" },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("done");
    expect(result.content).not.toContain("ENXIO");
  });
});
