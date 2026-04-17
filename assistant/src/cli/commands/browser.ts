/**
 * `assistant browser` CLI namespace.
 *
 * One subcommand per browser operation, driven from the shared
 * browser operations contract ({@link BROWSER_OPERATION_META}).
 * Each subcommand maps CLI kebab-case flags into snake_case input
 * keys and calls `browser_execute` over the CLI IPC socket.
 */

import { writeFileSync } from "node:fs";

import { type Command, Option } from "commander";

import { BROWSER_OPERATION_META } from "../../browser/operations.js";
import type {
  BrowserOperationMeta,
  OperationField,
} from "../../browser/types.js";
import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

// ── Naming helpers ───────────────────────────────────────────────────

/**
 * Convert a snake_case operation name to kebab-case for CLI subcommand
 * names (e.g. `press_key` -> `press-key`).
 */
function toKebab(snakeCase: string): string {
  return snakeCase.replace(/_/g, "-");
}

/**
 * Convert a snake_case field name to a kebab-case CLI option flag
 * (e.g. `allow_private_network` -> `--allow-private-network`).
 *
 * Boolean fields declare only `--flag`; Commander 13 auto-generates
 * the `--no-flag` negation variant. Declaring both in a single spec
 * string (e.g. `--flag, --no-flag`) breaks in Commander 13 because
 * `--flag` still parses to `false`.
 */
function fieldToFlag(field: OperationField): string {
  const kebab = toKebab(field.name);
  if (field.type === "boolean") {
    return `--${kebab}`;
  }
  return `--${kebab} <${field.type === "number" ? "number" : "value"}>`;
}

/**
 * Convert a kebab-case option key back to snake_case for the IPC
 * input object (e.g. `allowPrivateNetwork` -> `allow_private_network`).
 *
 * Commander camelCases option names, so we convert from camelCase
 * to snake_case.
 */
function camelToSnake(camel: string): string {
  return camel.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/**
 * Parse a CLI option value according to its field type.
 */
function parseFieldValue(
  value: unknown,
  field: OperationField,
): string | number | boolean {
  if (field.type === "boolean") return Boolean(value);
  if (field.type === "number") {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid number for --${toKebab(field.name)}: ${value}`);
    }
    return num;
  }
  return String(value);
}

// ── IPC response shape ───────────────────────────────────────────────

interface BrowserExecuteResult {
  content: string;
  isError: boolean;
  screenshots?: Array<{ mediaType: string; data: string }>;
}

// ── Subcommand builder ───────────────────────────────────────────────

/**
 * Build a Commander subcommand for a single browser operation.
 */
function buildSubcommand(parent: Command, meta: BrowserOperationMeta): void {
  const subcmd = parent
    .command(toKebab(meta.operation))
    .description(meta.description);

  // Add per-operation field options
  for (const field of meta.fields) {
    const flag = fieldToFlag(field);

    if (field.enum) {
      // Use Commander's Option class with .choices() for enum-constrained
      // fields so invalid values are rejected at the CLI level and
      // --help lists the allowed values.
      const opt = new Option(flag, field.description).choices([...field.enum]);
      if (field.required) {
        opt.makeOptionMandatory(true);
      }
      subcmd.addOption(opt);
    } else if (field.required) {
      subcmd.requiredOption(flag, field.description);
    } else {
      subcmd.option(flag, field.description);
    }
  }

  // Append per-operation help text with behavioral notes and examples
  if (meta.helpText) {
    subcmd.addHelpText("after", `\n${meta.helpText}`);
  }

  // screenshot gets an --output <path> option for writing JPEG to disk
  if (meta.operation === "screenshot") {
    subcmd.option(
      "--output <path>",
      "Write the screenshot JPEG to a file path on disk.",
    );
  }

  subcmd.action(async (opts: Record<string, unknown>) => {
    const parentOpts = parent.opts() as {
      session?: string;
      json?: boolean;
    };
    const sessionId = parentOpts.session ?? "default";
    const jsonMode = parentOpts.json ?? false;

    // Map Commander camelCase options back to snake_case input keys,
    // filtering out parent-level options (session, json) and screenshot
    // ergonomics (output).
    const input: Record<string, unknown> = {};
    const excludeKeys = new Set(["session", "json", "output"]);

    for (const [key, value] of Object.entries(opts)) {
      if (excludeKeys.has(key)) continue;
      if (value === undefined) continue;

      const snakeKey = camelToSnake(key);
      // Find the matching field for type coercion
      const field = meta.fields.find((f) => f.name === snakeKey);
      if (field) {
        input[snakeKey] = parseFieldValue(value, field);
      } else {
        input[snakeKey] = value;
      }
    }

    const ipcResult = await cliIpcCall<BrowserExecuteResult>(
      "browser_execute",
      {
        operation: meta.operation,
        input,
        sessionId,
      },
    );

    if (!ipcResult.ok) {
      if (jsonMode) {
        process.stdout.write(
          JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
        );
      } else {
        log.error(`Error: ${ipcResult.error}`);
      }
      process.exitCode = 1;
      return;
    }

    const result = ipcResult.result!;

    if (result.isError) {
      if (jsonMode) {
        process.stdout.write(
          JSON.stringify({ ok: false, error: result.content }) + "\n",
        );
      } else {
        log.error(result.content);
      }
      process.exitCode = 1;
      return;
    }

    // Handle screenshot --output: write JPEG to disk
    if (
      meta.operation === "screenshot" &&
      opts.output &&
      result.screenshots?.length
    ) {
      const screenshot = result.screenshots[0];
      const buffer = Buffer.from(screenshot.data, "base64");
      try {
        writeFileSync(String(opts.output), buffer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({
              ok: false,
              error: `Failed to write screenshot to ${opts.output}: ${msg}`,
            }) + "\n",
          );
        } else {
          log.error(`Failed to write screenshot to ${opts.output}: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }
      if (!jsonMode) {
        log.info(`Screenshot saved to ${opts.output}`);
      }
    }

    if (jsonMode) {
      const payload: Record<string, unknown> = {
        ok: true,
        content: result.content,
      };
      // Include base64 screenshot data in JSON output
      if (result.screenshots?.length) {
        payload.screenshots = result.screenshots;
      }
      process.stdout.write(JSON.stringify(payload) + "\n");
    } else {
      if (result.content) {
        log.info(result.content);
      }
    }
  });
}

// ── Registration ─────────────────────────────────────────────────────

export function registerBrowserCommand(program: Command): void {
  const browser = program
    .command("browser")
    .description("Control the browser via the running assistant.")
    .option(
      "--session <id>",
      "Session ID to preserve browser state across invocations.",
      "default",
    )
    .option("--json", "Output results as machine-readable JSON.");

  browser.addHelpText(
    "after",
    `
Browser operations are executed through the running assistant.
Each subcommand maps to a browser operation and communicates
with the assistant process.

The --session flag groups sequential commands so they share browser
state (same page, cookies, etc.). Different session IDs create
independent browser contexts.

Examples:
  $ assistant browser navigate --url https://example.com
  $ assistant browser snapshot
  $ assistant browser click --selector "#login"
  $ assistant browser type --text "hello" --element-id e14
  $ assistant browser screenshot --output page.jpg
  $ assistant browser --session myflow navigate --url https://example.com
  $ assistant browser --json screenshot`,
  );

  // Register one subcommand per browser operation
  for (const meta of BROWSER_OPERATION_META) {
    buildSubcommand(browser, meta);
  }
}
