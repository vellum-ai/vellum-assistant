import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { getNestedValue } from "../lib/nested-value.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { requirePlatformConnection } from "./oauth/shared.js";

/**
 * Flatten a nested config object into dotted key paths.
 * E.g. `{ a: { b: 1, c: 2 } }` becomes `{ "a.b": 1, "a.c": 2 }`.
 */
function flattenConfig(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenConfig(value as Record<string, unknown>, path),
      );
    } else {
      result[path] = value;
    }
  }
  return result;
}

/** Matches config paths like `services.image-generation.mode`, `services.web-search.mode`, etc. */
const SERVICE_MODE_PATH_RE = /^services\.[^.]+\.mode$/;

/**
 * Fetch the full raw config from the assistant via IPC.
 * On transport / connection error, prints a helpful message and exits.
 */
async function fetchRawConfig(
  cmd: Command,
): Promise<Record<string, unknown> | undefined> {
  const ipcResult = await cliIpcCall<Record<string, unknown>>("config_get");
  if (!ipcResult.ok) {
    exitFromIpcResult(ipcResult, cmd);
    return undefined;
  }
  return ipcResult.result ?? {};
}

export function registerConfigCommand(program: Command): void {
  registerCommand(program, {
    name: "config",
    transport: "ipc",
    description: "Manage configuration",
    build: (config) => {

  config.addHelpText(
    "after",
    `
Configuration is managed by the assistant. The CLI sends every read/write
through the assistant so the in-memory cache, provider registry, and
file-watcher stay coherent with config.json.

Keys support dotted paths for nested values (e.g. calls.enabled,
twilio.accountSid). Values are auto-parsed as JSON (booleans, numbers,
objects) with fallback to plain string if parsing fails.

API keys are managed separately via secure storage. Use "assistant keys list"
and "assistant keys set <provider> <key>" to view and manage API keys.

Examples:
  $ assistant config list
  $ assistant config get llm.default.provider
  $ assistant config schema services
  $ assistant config set llm.default.provider anthropic
  $ assistant config set calls.enabled true`,
  );

  config
    .command("set <key> <value>")
    .description(
      "Set a config value (supports dotted paths like calls.enabled)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  key     Dotted path to the config key (e.g. llm.default.provider,
          calls.enabled, twilio.accountSid). Intermediate objects are created
          automatically.
  value   The value to store. Parsed as JSON first (so "true" becomes boolean
          true, "42" becomes number 42). Falls back to plain string if JSON
          parsing fails.

The CLI sends the change to the assistant, which assigns the value at the
given path, invalidates caches, and reinitializes providers so the new
value takes effect immediately. Object subtrees replace (not merge), and
explicit null is preserved.

To manage API keys, use "assistant keys set <provider> <key>" instead.

Examples:
  $ assistant config set llm.default.provider anthropic
  $ assistant config set calls.enabled true`,
    )
    .action(
      async (key: string, value: string, _opts: unknown, cmd: Command) => {
        // Try to parse as JSON for booleans/numbers, fall back to string
        let parsed: unknown = value;
        try {
          parsed = JSON.parse(value);
        } catch {
          // keep as string
        }

        // Require platform connection when setting a service mode to "managed"
        if (SERVICE_MODE_PATH_RE.test(key) && parsed === "managed") {
          const connected = await requirePlatformConnection(cmd);
          if (!connected) return;
        }

        // Direct-replacement set semantics (preserves null, replaces objects).
        // See conversation-query-routes.ts:handleSetConfig for why this is a
        // separate route from config_patch.
        const result = await cliIpcCall("config_set", {
          body: { path: key, value: parsed },
        });
        if (!result.ok) {
          exitFromIpcResult(result, cmd);
          return;
        }
        log.info(`Set ${key} = ${JSON.stringify(parsed)}`);
      },
    );

  config
    .command("get <key>")
    .description("Get a config value (supports dotted paths)")
    .addHelpText(
      "after",
      `
Arguments:
  key   Dotted path to the config key (e.g. llm.default.provider,
        calls.enabled)

Fetches the full config from the assistant and prints the value at the
given key path. If the key is not set, prints "(not set)". Object
values are pretty-printed as indented JSON.

To view API keys, use "assistant keys list" instead.

Examples:
  $ assistant config get llm.default.provider
  $ assistant config get calls.enabled`,
    )
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      const raw = await fetchRawConfig(cmd);
      if (!raw) return;
      const value = getNestedValue(raw, key);
      if (value === undefined) {
        log.info(`(not set)`);
      } else {
        log.info(
          typeof value === "object"
            ? JSON.stringify(value, null, 2)
            : String(value),
        );
      }
    });

  config
    .command("schema [path]")
    .description("Print the JSON Schema for the config (or a sub-path)")
    .addHelpText(
      "after",
      `
Arguments:
  path   Optional dotted path to a config key (e.g. calls, memory.segmentation)

Asks the assistant for the JSON Schema of the entire config object, or
the sub-schema at the given path. Useful for understanding available
fields, their types, defaults, and constraints.

Examples:
  $ assistant config schema
  $ assistant config schema calls
  $ assistant config schema memory.segmentation`,
    )
    .action(async (path: string | undefined, _opts: unknown, cmd: Command) => {
      const result = await cliIpcCall<{ schema: unknown }>(
        "config_schema_get",
        path ? { queryParams: { path } } : undefined,
      );
      if (!result.ok) {
        exitFromIpcResult(result, cmd);
        return;
      }
      log.info(JSON.stringify(result.result?.schema ?? {}, null, 2));
    });

  config
    .command("list")
    .description("List all config values")
    .option(
      "--search <query>",
      "Filter config entries by case-insensitive substring match on key name",
    )
    .addHelpText(
      "after",
      `
Fetches the full raw configuration from the assistant and prints it as
pretty-printed JSON. If no configuration has been set, prints
"No configuration set".

The --search flag filters results by case-insensitive substring match against
flattened dotted key paths. For example, --search calls matches calls.enabled,
calls.recordingEnabled, and any other key containing "calls".

Examples:
  $ assistant config list
  $ assistant config list --search api
  $ assistant config list --search calls`,
    )
    .action(async (opts: { search?: string }, cmd: Command) => {
      const raw = await fetchRawConfig(cmd);
      if (!raw) return;
      if (Object.keys(raw).length === 0) {
        log.info("No configuration set");
        return;
      }

      if (!opts.search) {
        log.info(JSON.stringify(raw, null, 2));
        return;
      }

      const flat = flattenConfig(raw);
      const query = opts.search.toLowerCase();
      const matched = Object.fromEntries(
        Object.entries(flat).filter(([key]) =>
          key.toLowerCase().includes(query),
        ),
      );

      if (Object.keys(matched).length === 0) {
        log.info(`No config keys matching "${opts.search}"`);
      } else {
        for (const [key, value] of Object.entries(matched)) {
          log.info(
            `${key} = ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
          );
        }
      }
    });

  config
    .command("validate-allowlist")
    .description("Validate regex patterns in secret-allowlist.json")
    .addHelpText(
      "after",
      `
Reads secret-allowlist.json from the workspace and checks each regex pattern
for syntax errors. Reports the index and error message for any invalid
patterns. Exits with code 1 if any patterns are invalid, or prints a success
message if all patterns are valid. If no secret-allowlist.json file exists,
reports that and exits normally.

Examples:
  $ assistant config validate-allowlist`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const result = await cliIpcCall<{
        exists: boolean;
        parseError?: string;
        errors?: Array<{ index: number; pattern: string; message: string }>;
      }>("config_allowlist_validate");
      if (!result.ok) {
        exitFromIpcResult(result, cmd);
        return;
      }
      const payload = result.result;
      if (!payload || !payload.exists) {
        log.info("No secret-allowlist.json file found");
        return;
      }
      // The daemon surfaces a malformed-JSON failure as `parseError` so
      // the CLI can print a single user-readable message and exit 1,
      // matching the pre-IPC behavior.
      if (payload.parseError) {
        log.error(
          `Failed to read secret-allowlist.json: ${payload.parseError}`,
        );
        process.exit(1);
      }
      const errors = payload.errors ?? [];
      if (errors.length === 0) {
        log.info("All patterns in secret-allowlist.json are valid");
        return;
      }
      log.error(
        `Found ${errors.length} invalid pattern(s) in secret-allowlist.json:`,
      );
      for (const e of errors) {
        log.error(`  [${e.index}] "${e.pattern}": ${e.message}`);
      }
      process.exit(1);
    });
    },
  });
}
