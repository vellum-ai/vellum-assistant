/**
 * `assistant tools` — inspect and run the tools registered with the running
 * assistant (core built-ins plus skill-, plugin-, and MCP-contributed
 * tools).
 *
 * `tools list` is a thin `ipc` wrapper that reads the daemon's live registry.
 * `tools run` (see `./tools-run.ts`) executes a tool in-process from the
 * filesystem and is registered here as a sibling subcommand.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { toolsHelp } from "./tools.help.js";
import { registerToolsRunCommand } from "./tools-run.js";

interface ToolListEntry {
  name: string;
  description: string;
  riskLevel: string;
  category: string;
  source: string;
}

interface ToolsGetResponse {
  names: string[];
  schemas: Record<string, unknown>;
  tools: ToolListEntry[];
}

export function registerToolsCommand(program: Command): void {
  registerCommand(program, {
    name: toolsHelp.name,
    transport: "ipc",
    description: toolsHelp.description,
    build: (tools) => {
      applyCommandHelp(tools, toolsHelp);

      // `list` keeps its `ls` alias imperatively — the help contract cannot
      // express command aliases.
      subcommand(tools, "list")
        .alias("ls")
        .action(
          async (opts: {
            json?: boolean;
            conversation?: string;
            agent?: string;
          }) => {
            const response = await cliIpcCall<ToolsGetResponse>("tools_get", {
              queryParams: {
                ...(opts.conversation
                  ? { conversationId: opts.conversation }
                  : {}),
                ...(opts.agent ? { agent: opts.agent } : {}),
              },
            });
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
              const description =
                t.description.length > 50
                  ? `${t.description.slice(0, 50)}…`
                  : t.description;
              console.log(
                `${t.name.padEnd(nameW)}  ${t.source.padEnd(sourceW)}  ${t.riskLevel.padEnd(riskW)}  ${description}`,
              );
            }
            console.log(`\n${tools.length} tool(s)`);
          },
        );

      // `run` executes a tool in-process (transport: "local"), so it lives in
      // its own file and is composed in here as a sibling subcommand.
      registerToolsRunCommand(tools);
    },
  });
}
