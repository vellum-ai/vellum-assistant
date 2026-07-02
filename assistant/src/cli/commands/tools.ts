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
import { registerCommand } from "../lib/register-command.js";
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

By default the global registry is listed. Pass --conversation to scope the
list to the tools available to one conversation as of its most recent turn —
including skill/MCP tools it registered over its lifecycle.

'tools run' executes a single tool directly, outside the agent loop. It runs
in-process from the filesystem (core built-ins + workspace tools), and is
non-interactive and non-guardian: read-only / low-risk tools execute, while
prompt-gated tools are auto-denied (there is no client to approve them). A
tool error exits non-zero so it composes in scripts.

Examples:
  $ assistant tools list
  $ assistant tools ls
  $ assistant tools list --json
  $ assistant tools list --conversation conv_abc123
  $ assistant tools run web_fetch --input '{"url":"https://example.com"}'
  $ assistant tools run file_read --input-file args.json
  $ echo '{"path":"."}' | assistant tools run list_dir --input-file -`,
      );

      tools
        .command("list")
        .alias("ls")
        .description(
          "List all registered tools with their source and risk level",
        )
        .option("--json", "Emit machine-readable JSON instead of a table")
        .option(
          "--conversation <id>",
          "Scope to one conversation's tools as of its most recent turn — run 'assistant conversations list' to find the id",
        )
        .action(async (opts: { json?: boolean; conversation?: string }) => {
          const response = await cliIpcCall<ToolsGetResponse>(
            "tools_get",
            opts.conversation
              ? { queryParams: { conversationId: opts.conversation } }
              : undefined,
          );
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
        });

      // `run` executes a tool in-process (transport: "local"), so it lives in
      // its own file and is composed in here as a sibling subcommand.
      registerToolsRunCommand(tools);
    },
  });
}
