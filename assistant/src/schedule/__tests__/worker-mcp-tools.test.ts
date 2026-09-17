/**
 * Guard over the schedule worker entrypoint's MCP bootstrap.
 *
 * Behavioral coverage lives in worker-mcp-readiness.test.ts. This file only
 * asserts the process entrypoint still calls the extracted helpers before
 * the first tick, because the entrypoint installs signal handlers and
 * calls process.exit and cannot be imported into a test process.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const MCP_BOOTSTRAP = "bootstrapScheduleWorkerMcp(";
const MCP_RELOAD = "reloadScheduleWorkerMcp(";
const MCP_WATCH = "watchForMcpReload(";
const WORK_START = "void tick()";

function readWorkerSource(): string {
  return readFileSync(join(process.cwd(), "src/schedule/worker.ts"), "utf8");
}

describe("schedule worker MCP tools", () => {
  test("bootstraps its own MCP servers before the first schedule tick", () => {
    const source = readWorkerSource();
    const mcpAt = source.indexOf(MCP_BOOTSTRAP);
    const workAt = source.indexOf(WORK_START);

    expect(
      mcpAt,
      `The schedule worker must call \`${MCP_BOOTSTRAP})\` at startup. This ` +
        "process hosts execute-mode schedule turns, and its tool registry is " +
        "its own: without the call it has no mcp__* tools at all.",
    ).toBeGreaterThanOrEqual(0);
    expect(workAt).toBeGreaterThanOrEqual(0);
    expect(
      mcpAt < workAt,
      "The connect starts and is waited on before the first tick. Tool-backed " +
        "schedules stay deferred until that surface is marked ready.",
    ).toBe(true);
  });

  test("rebuilds its MCP set when the daemon reports a reload", () => {
    const source = readWorkerSource();

    expect(
      source.includes(MCP_WATCH) && source.includes(MCP_RELOAD),
      "This process is long-lived and holds its own connections. Without " +
        "the watcher, a server disabled or removed in the config stays " +
        "registered and callable by background schedules until the worker " +
        "restarts. Reload must mark the tool surface unready until it settles.",
    ).toBe(true);
  });
});
