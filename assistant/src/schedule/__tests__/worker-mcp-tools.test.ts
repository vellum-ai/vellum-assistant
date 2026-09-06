/**
 * Guard over the schedule worker entrypoint's MCP bootstrap.
 *
 * The tool registry is process-local and MCP tools reach it only by connecting
 * to each server and listing what it offers. `initializeTools()` does not do
 * that: it loads core built-ins and workspace tools from disk. So a worker
 * that stops connecting fails every `mcp__*` call an execute-mode schedule
 * makes as "Unknown tool", while `assistant tools list` reads the daemon's
 * registry over IPC and reports the same tool as registered. The mismatch is
 * what makes the failure hard to place, so it is worth a guard.
 *
 * The worker is also long-lived, so the set it connects at startup goes stale
 * as soon as the config moves. It watches for the daemon's reload signal to
 * rebuild, which is covered here too.
 *
 * The entrypoint installs signal handlers and calls `process.exit`, so it
 * cannot be imported into a test process; these assertions read its source the
 * way `worker-feature-flags.test.ts` does. The behavior of the steps
 * themselves is covered in `src/mcp/__tests__/startup.test.ts` and
 * `src/mcp/__tests__/reload-signal.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const MCP_CALL = "startConfiguredMcpServers(";

/** The bounded wait that keeps unreachable servers off the critical path. */
const MCP_GRACE = "MCP_STARTUP_GRACE_MS";

/** The reload watcher that keeps the connected set current. */
const MCP_WATCH = "watchForMcpReload(";

/** The worker's first call that can execute a schedule. */
const WORK_START = "void tick()";

function readWorkerSource(): string {
  return readFileSync(join(process.cwd(), "src/schedule/worker.ts"), "utf8");
}

describe("schedule worker MCP tools", () => {
  test("connects its own MCP servers before the first schedule tick", () => {
    const source = readWorkerSource();
    const mcpAt = source.indexOf(MCP_CALL);
    const workAt = source.indexOf(WORK_START);

    expect(
      mcpAt,
      `The schedule worker must call \`${MCP_CALL})\` at startup. This ` +
        "process hosts execute-mode schedule turns, and its tool registry is " +
        "its own: without the call it has no mcp__* tools at all.",
    ).toBeGreaterThanOrEqual(0);
    expect(workAt).toBeGreaterThanOrEqual(0);
    expect(
      mcpAt < workAt,
      "The connect starts and is waited on before the first tick, so a " +
        "schedule that fires immediately runs with the tools it was written " +
        "against. The wait is bounded (see below), so a server that never " +
        "answers delays it rather than blocking it.",
    ).toBe(true);
  });

  test("bounds the startup wait so unrelated schedules still fire", () => {
    const source = readWorkerSource();

    expect(
      source.includes(MCP_GRACE),
      "`McpServerManager.start()` walks servers one at a time and allows " +
        "each 30s to connect and 30s more to list its tools. An unbounded " +
        "wait lets a few unreachable servers hold every due schedule, " +
        "including the notify and script ones that never touch MCP, while " +
        "the PID file already reports this worker as running.",
    ).toBe(true);
  });

  test("rebuilds its MCP set when the daemon reports a reload", () => {
    const source = readWorkerSource();

    expect(
      source.includes(MCP_WATCH),
      "This process is long-lived and holds its own connections. Without " +
        "the watcher, a server disabled or removed in the config stays " +
        "registered and callable by background schedules until the worker " +
        "restarts.",
    ).toBe(true);
  });
});
