import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import {
  MAX_OUTPUT_LENGTH,
  OUTPUT_TRUNCATED_TAG,
} from "../shared/shell-output.js";
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

// The shell tool reads only `timeouts.shell{Default,Max}TimeoutSec`; seed the
// non-default bounds the tests exercise.
setConfig("timeouts", { shellDefaultTimeoutSec: 30, shellMaxTimeoutSec: 60 });

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

describe("streaming stdout cap", () => {
  let tmpDir = "";

  beforeEach(async () => {
    events.length = 0;
    _clearRegistryForTesting();
    tmpDir = await mkdtemp(join(tmpdir(), "bash-cap-"));
  });

  afterEach(async () => {
    _clearRegistryForTesting();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("foreground drops stdout past the cap and lets the process finish", async () => {
    const result = await shellTool.execute(
      {
        command: `${process.execPath} -e "process.stdout.write('x'.repeat(100000)); require('node:fs').writeFileSync('sentinel.txt','done')"`,
        activity: "test",
      },
      { ...makeContext(), workingDir: tmpDir },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain(OUTPUT_TRUNCATED_TAG);
    expect(result.content).not.toContain("file=");
    expect(result.content.length).toBeLessThan(MAX_OUTPUT_LENGTH + 80);
    expect(await readFile(join(tmpDir, "sentinel.txt"), "utf-8")).toBe("done");
  });

  test("background drops stdout past the cap and lets the process finish", async () => {
    const result = await shellTool.execute(
      {
        command: `${process.execPath} -e "process.stdout.write('x'.repeat(100000)); require('node:fs').writeFileSync('sentinel.txt','done')"`,
        activity: "test",
        background: true,
      },
      { ...makeContext(), workingDir: tmpDir },
    );
    expect(result.isError).toBeFalsy();

    await waitFor(() => completedEvents().length > 0);
    const completed = completedEvents();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "completed", exitCode: 0 });
    expect(String(completed[0]?.output)).toContain(OUTPUT_TRUNCATED_TAG);
    expect(String(completed[0]?.output)).not.toContain("file=");
    expect(String(completed[0]?.output).length).toBeLessThan(
      MAX_OUTPUT_LENGTH + 80,
    );
    expect(await readFile(join(tmpDir, "sentinel.txt"), "utf-8")).toBe("done");
  });
});
