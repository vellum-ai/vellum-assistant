/**
 * Render tests for `assistant tools list` (cli/commands/tools.ts).
 *
 * The daemon reads `--agent` the way a spawn reads its `role` field, so a
 * listing can come back for a different type than the one asked for. These
 * tests pin that the command says which type it is showing instead of printing
 * a table that looks like it was asked for by name. Tool projection itself is
 * covered daemon-side in `tools-get-route.test.ts`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

interface IpcResult {
  ok: boolean;
  result?: unknown;
}

let ipcResponse: IpcResult = { ok: true, result: undefined };

mock.module("../ipc/cli-client.js", () => ({
  cliIpcCall: async () => ipcResponse,
  exitFromIpcResult: () => {
    throw new Error("unexpected IPC failure");
  },
}));

const { registerToolsCommand } = await import("../cli/commands/tools.js");

const TOOL_ENTRY = {
  name: "file_read",
  description: "Read a file",
  riskLevel: "low",
  category: "filesystem",
  source: "core",
};

async function runList(args: string[]): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    const program = new Command();
    program.exitOverride();
    registerToolsCommand(program);
    await program.parseAsync(["node", "assistant", "tools", "list", ...args]);
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

describe("assistant tools list --agent", () => {
  beforeEach(() => {
    ipcResponse = { ok: true, result: undefined };
  });

  test("names the type an older role name resolved to", async () => {
    ipcResponse = {
      ok: true,
      result: {
        names: [TOOL_ENTRY.name],
        schemas: {},
        tools: [TOOL_ENTRY],
        agent: {
          requested: "planner",
          role: "researcher",
          alias: "planner",
        },
      },
    };

    const output = await runList(["--agent", "planner"]);

    expect(output).toContain('"planner" is an older name for "researcher"');
    expect(output).toContain("file_read");
  });

  test("says a value that is not a type ran as a persona", async () => {
    // The whole failure this catches: an unknown value used to be an error and
    // now lists a researcher's tools, which is indistinguishable from asking
    // for a researcher unless the command says so.
    ipcResponse = {
      ok: true,
      result: {
        names: [TOOL_ENTRY.name],
        schemas: {},
        tools: [TOOL_ENTRY],
        agent: {
          requested: "subagent_typo",
          role: "researcher",
          persona: "subagent_typo",
        },
      },
    };

    const output = await runList(["--agent", "subagent_typo"]);

    expect(output).toContain('"subagent_typo" is not a subagent type');
    expect(output).toContain("runs as a researcher");
  });

  test("a type asked for by name gets no resolution line", async () => {
    ipcResponse = {
      ok: true,
      result: {
        names: [TOOL_ENTRY.name],
        schemas: {},
        tools: [TOOL_ENTRY],
        agent: { requested: "researcher", role: "researcher" },
      },
    };

    const output = await runList(["--agent", "researcher"]);

    expect(output).not.toContain("older name");
    expect(output).not.toContain("persona");
    expect(output.startsWith("NAME")).toBe(true);
  });

  test("--json carries the whole payload, resolution block included", async () => {
    const result = {
      names: [TOOL_ENTRY.name],
      schemas: { file_read: { type: "object" } },
      tools: [TOOL_ENTRY],
      agent: {
        requested: "subagent_typo",
        role: "researcher",
        persona: "subagent_typo",
      },
    };
    ipcResponse = { ok: true, result };

    const output = await runList(["--agent", "subagent_typo", "--json"]);

    expect(JSON.parse(output)).toEqual(result);
  });
});
