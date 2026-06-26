/**
 * `assistant tools run <name>` — execute a single registered tool directly,
 * outside the agent loop.
 *
 * This is a `local`-transport subcommand: it runs the tool in-process from the
 * filesystem (no daemon, no IPC), via {@link runToolStandalone}. It covers the
 * tools the registry loads from the filesystem (core built-ins and workspace
 * tools); skill / plugin / MCP tools that a running daemon registers over its
 * lifecycle are not visible here.
 */

import { readFileSync } from "node:fs";

import type { Command } from "commander";

import {
  runToolStandalone,
  UnknownToolError,
} from "../../tools/run-standalone.js";
import { registerCommand } from "../lib/register-command.js";

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

export function registerToolsRunCommand(parent: Command): void {
  registerCommand(parent, {
    name: "run",
    transport: "local",
    description: "Execute a single registered tool directly",
    build: (run) => {
      run
        .argument("<name>", "Name of the registered tool to execute")
        .option("--input <json>", "Tool input as a JSON object (default: {})")
        .option(
          "--input-file <path>",
          'Read JSON input from a file ("-" reads stdin)',
        )
        .option("--json", "Emit the full machine-readable result as JSON")
        .action(
          async (
            name: string,
            opts: { input?: string; inputFile?: string; json?: boolean },
          ) => {
            const input = resolveToolInput(opts);

            let result;
            try {
              result = await runToolStandalone(name, input);
            } catch (error) {
              if (error instanceof UnknownToolError) {
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
    },
  });
}
