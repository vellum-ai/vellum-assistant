/**
 * `assistant tools` — inspect the tools registered with the running
 * assistant (core built-ins plus skill-, plugin-, and MCP-contributed
 * tools).
 *
 * Thin `ipc` wrapper: each subcommand forwards to a single daemon route and
 * renders the response. The registry lives in the daemon, so these commands
 * require the daemon to be running.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";

interface ToolListEntry {
  name: string;
  description: string;
  riskLevel: string;
  category: string;
  source: string;
}

interface ToolsListResponse {
  tools: ToolListEntry[];
}

export function registerToolsCommand(program: Command): void {
  registerCommand(program, {
    name: "tools",
    transport: "ipc",
    description: "Inspect tools registered with the running assistant",
    build: (tools) => {
      tools.addHelpText(
        "after",
        `
Tools are registered with the daemon from four sources: core built-ins,
skills, external plugins, and MCP servers. The "source" column reports the
origin as "core" or "<kind>:<id>" (e.g. "plugin:echo", "skill:my-skill",
"mcp:linear"). The risk level is the author-asserted default band used for
permission gating, not the runtime-classified risk of a specific call.

Examples:
  $ assistant tools list
  $ assistant tools ls
  $ assistant tools list --json`,
      );

      tools
        .command("list")
        .alias("ls")
        .description(
          "List all registered tools with their source and risk level",
        )
        .option("--json", "Emit machine-readable JSON instead of a table")
        .action(async (opts: { json?: boolean }) => {
          const response = await cliIpcCall<ToolsListResponse>("tools_list");
          if (!response.ok) {
            return exitFromIpcResult(response);
          }

          const tools = response.result?.tools ?? [];

          if (opts.json) {
            console.log(JSON.stringify(tools, null, 2));
            return;
          }

          if (tools.length === 0) {
            console.log("No tools registered.");
            return;
          }

          const nameW = Math.max(4, ...tools.map((t) => t.name.length));
          const sourceW = Math.max(6, ...tools.map((t) => t.source.length));
          const riskW = Math.max(4, ...tools.map((t) => t.riskLevel.length));

          console.log(
            `${"NAME".padEnd(nameW)}  ${"SOURCE".padEnd(sourceW)}  ${"RISK".padEnd(riskW)}  DESCRIPTION`,
          );
          for (const t of tools) {
            console.log(
              `${t.name.padEnd(nameW)}  ${t.source.padEnd(sourceW)}  ${t.riskLevel.padEnd(riskW)}  ${t.description}`,
            );
          }
          console.log(`\n${tools.length} tool(s)`);
        });
    },
  });
}
