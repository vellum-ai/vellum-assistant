/**
 * `assistant tools run` resolves its tool through the daemon.
 *
 * The tool registry is per-process. Skill, plugin, and MCP tools are registered
 * in the daemon over its lifetime and exist nowhere else, so this short-lived
 * CLI process resolving the name itself reaches only core built-ins and
 * workspace tools. That is why `tools list`, which already reads the daemon's
 * registry over IPC, could report an `mcp__*` tool that `tools run` then
 * rejected as unknown.
 *
 * The fallback matters as much as the daemon path: it must be taken when no
 * daemon answers (so a core tool still runs while the assistant is asleep) and
 * only then. Retrying a daemon-side failure against the smaller local registry
 * would turn a real error into a misleading "Unknown tool" for precisely the
 * tools this path exists to reach.
 */

import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

import type { CliIpcCallResult } from "../../../ipc/cli-client.js";
import type { StandaloneToolResult } from "../../../tools/run-standalone.js";

let ipcResponse: CliIpcCallResult<StandaloneToolResult> = {
  ok: false,
  error: "unset",
};
const cliIpcCall = jest.fn(async () => ipcResponse);

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall,
  exitFromIpcResult: jest.fn(),
}));

class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(`Unknown tool "${toolName}".`);
    this.name = "UnknownToolError";
  }
}

const runToolStandalone = jest.fn(async (toolName: string) => ({
  toolName,
  content: "from the local registry",
  isError: false,
}));

mock.module("../../../tools/run-standalone.js", () => ({
  runToolStandalone,
  UnknownToolError,
}));

const { runToolForCli, ToolRunFailure } = await import("../tools-run.js");

const daemonResult: StandaloneToolResult = {
  toolName: "mcp__fastmail__search_email",
  content: "from the daemon registry",
  isError: false,
  riskLevel: "low",
};

beforeEach(() => {
  cliIpcCall.mockClear();
  runToolStandalone.mockClear();
});

describe("runToolForCli", () => {
  test("runs through the daemon when one answers", async () => {
    ipcResponse = { ok: true, result: daemonResult };

    const result = await runToolForCli("mcp__fastmail__search_email", {
      query: "in:inbox",
    });

    expect(result).toEqual(daemonResult);
    expect(cliIpcCall).toHaveBeenCalledWith(
      "tools_run_post",
      { toolName: "mcp__fastmail__search_email", input: { query: "in:inbox" } },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(
      runToolStandalone,
      "A reachable daemon must resolve the name; the local registry has no " +
        "MCP tools at all.",
    ).not.toHaveBeenCalled();
  });

  test("falls back to this process when no daemon is reachable", async () => {
    ipcResponse = { ok: false, error: "no socket", notConnected: true };

    const result = await runToolForCli("file_list", { path: "." });

    expect(result.content).toBe("from the local registry");
    expect(runToolStandalone).toHaveBeenCalledWith("file_list", { path: "." });
  });

  test("a daemon-side error is reported, never retried locally", async () => {
    ipcResponse = {
      ok: false,
      error: "Missing required scope: settings.write",
      statusCode: 403,
    };

    await expect(runToolForCli("file_list", {})).rejects.toThrow(
      ToolRunFailure,
    );
    expect(
      runToolStandalone,
      "Retrying locally would answer a real daemon failure with a smaller " +
        "registry's verdict, reporting the wrong problem.",
    ).not.toHaveBeenCalled();
  });

  test("an unknown tool in the fallback path fails with the daemon's message", async () => {
    ipcResponse = { ok: false, error: "no socket", notConnected: true };
    runToolStandalone.mockImplementationOnce(async (toolName: string) => {
      throw new UnknownToolError(toolName);
    });

    await expect(runToolForCli("nope", {})).rejects.toThrow(ToolRunFailure);
  });

  test("a tool result that is an error is returned, not thrown", async () => {
    ipcResponse = {
      ok: true,
      result: { ...daemonResult, isError: true, content: "denied" },
    };

    const result = await runToolForCli("bash", { command: "ls" });

    expect(result.isError).toBe(true);
    expect(result.content).toBe("denied");
  });
});
