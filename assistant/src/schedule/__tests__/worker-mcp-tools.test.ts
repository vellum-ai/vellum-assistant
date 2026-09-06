/**
 * Guard over the schedule worker entrypoint's MCP bootstrap.
 *
 * The tool registry is process-local and MCP tools reach it only by connecting
 * to each server and listing what it offers. `initializeTools()` does not do
 * that — it loads core built-ins and workspace tools from disk — so a worker
 * that stops connecting fails every `mcp__*` call an execute-mode schedule
 * makes as "Unknown tool", while `assistant tools list` reads the daemon's
 * registry over IPC and reports the same tool as registered. The mismatch is
 * what makes the failure hard to place, so it is worth a guard.
 *
 * The entrypoint installs signal handlers and calls `process.exit`, so it
 * cannot be imported into a test process; these assertions read its source the
 * way `worker-feature-flags.test.ts` does. The behavior of the step itself is
 * covered in `src/mcp/__tests__/startup.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const MCP_CALL = "startConfiguredMcpServers(";

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
      "The MCP connect must complete before the first tick, so a schedule " +
        "that fires immediately runs with the tools it was written against.",
    ).toBe(true);
  });
});
