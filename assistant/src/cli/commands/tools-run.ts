/**
 * `assistant tools run <name>` — execute a single registered tool directly,
 * outside the agent loop.
 *
 * Runs through the daemon when one is up, because the tool registry is
 * per-process: skill, plugin, and MCP tools are registered in the daemon over
 * its lifetime and exist nowhere else. Resolving the name in this short-lived
 * CLI process instead would reach only what the registry loads from the
 * filesystem (core built-ins and workspace tools), which is why
 * `assistant tools list` could show `mcp__*` tools that `tools run` then
 * rejected as unknown.
 *
 * With no daemon reachable it falls back to running in-process, so scripts that
 * only need a core tool keep working while the assistant is asleep. The
 * fallback is taken only when the socket is absent or refuses the connection;
 * a daemon that answered with an error is reported, never retried locally
 * against a smaller registry.
 *
 * Permissions are identical on both paths ({@link runToolStandalone} sets them
 * either way): non-interactive and non-guardian, so read-only / low-risk tools
 * execute and anything that would prompt is denied in the result.
 */

import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type { StandaloneToolResult } from "../../tools/run-standalone.js";
import { subcommand } from "../lib/cli-command-help.js";

/**
 * Resolve the `--input` / `--input-file` options to a parsed JSON object.
 * Exits the process with a clear message on any read/parse error so the
 * caller can assume a valid object. Defaults to `{}` when neither is given.
 */
function resolveToolInput(opts: {
  input?: string;
  inputFile?: string;
}): Record<string, unknown> {
  if (opts.input !== undefined && opts.inputFile !== undefined) {
    process.stderr.write(
      "Error: --input cannot be combined with --input-file.\n",
    );
    process.exit(2);
  }

  let raw = "{}";
  if (opts.inputFile !== undefined) {
    try {
      raw = readFileSync(opts.inputFile === "-" ? 0 : opts.inputFile, "utf-8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Error: could not read input file "${opts.inputFile}": ${reason}\n`,
      );
      process.exit(2);
    }
  } else if (opts.input !== undefined) {
    raw = opts.input;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: input is not valid JSON: ${reason}\n`);
    process.exit(2);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("Error: input must be a JSON object.\n");
    process.exit(2);
  }
  return parsed as Record<string, unknown>;
}

/**
 * How long to wait for the daemon to return a tool result.
 *
 * The daemon caps a single tool execution at `timeouts.toolExecutionTimeoutSec`
 * and answers with a timeout result of its own once that elapses, so this only
 * has to outlast that cap. Otherwise the CLI would abandon a call the daemon
 * is about to answer and report a transport failure for a tool that ran.
 */
async function daemonCallTimeoutMs(): Promise<number> {
  const IPC_OVERHEAD_MS = 15_000;
  // Imported lazily: both are daemon-internal, and a CLI command must keep
  // them out of its static graph (cli/no-daemon-internals).
  const [{ getConfig }, { safeTimeoutMs }] = await Promise.all([
    import("../../config/loader.js"),
    import("../../tools/execution-timeout.js"),
  ]);
  return (
    safeTimeoutMs(getConfig().timeouts?.toolExecutionTimeoutSec) +
    IPC_OVERHEAD_MS
  );
}

/**
 * A run that could not produce a result: an unknown tool name, or a daemon that
 * answered with an error. Carries the message the command prints before exiting
 * with status 2, which is what an unknown name has always done.
 */
export class ToolRunFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRunFailure";
  }
}

/**
 * Run `name` through the daemon, falling back to this process when no daemon
 * answers.
 *
 * A daemon that answered with an error is reported as it came and never
 * retried locally: the local registry is a strict subset of the daemon's, so
 * retrying would turn a real failure into a confusing "Unknown tool" for
 * exactly the skill, plugin, and MCP tools this path exists to reach.
 *
 * Exported for tests; the command below is its only other caller.
 */
export async function runToolForCli(
  name: string,
  input: Record<string, unknown>,
): Promise<StandaloneToolResult> {
  const ipc = await cliIpcCall<StandaloneToolResult>(
    "tools_run_post",
    { toolName: name, input },
    { timeoutMs: await daemonCallTimeoutMs() },
  );
  if (ipc.ok && ipc.result) {
    return ipc.result;
  }
  if (!ipc.notConnected) {
    throw new ToolRunFailure(ipc.error ?? "tool execution failed");
  }

  // No daemon. Deferred import: the executor graph loads only when a tool
  // actually runs in this process.
  const { runToolStandalone, UnknownToolError } =
    await import("../../tools/run-standalone.js");
  try {
    return await runToolStandalone(name, input);
  } catch (error) {
    if (error instanceof UnknownToolError) {
      throw new ToolRunFailure(error.message);
    }
    throw error;
  }
}

export function registerToolsRunCommand(parent: Command): void {
  subcommand(parent, "run").action(
    async (
      name: string,
      opts: { input?: string; inputFile?: string; json?: boolean },
    ) => {
      const input = resolveToolInput(opts);

      let result;
      try {
        result = await runToolForCli(name, input);
      } catch (error) {
        if (error instanceof ToolRunFailure) {
          process.stderr.write(`Error: ${error.message}\n`);
          process.exit(2);
        }
        throw error;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.content);
      }

      // A tool error exits non-zero so scripts and `&&` chains can react.
      if (result.isError) {
        process.exit(1);
      }
    },
  );
}
