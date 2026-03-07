import type { Command } from "commander";

import {
  getNestedValue,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
  syncConfigToLockfile,
} from "../../config/loader.js";
import { log } from "../logger.js";

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

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Manage configuration");

  config.addHelpText(
    "after",
    `
Configuration is stored in config.json in the assistant workspace directory.
Keys support dotted paths for nested values (e.g. calls.enabled, apiKeys.anthropic).
Values are auto-parsed as JSON (booleans, numbers, objects) with fallback to
plain string if parsing fails.

Examples:
  $ assistant config list
  $ assistant config get provider
  $ assistant config set provider anthropic
  $ assistant config set calls.enabled true`,
  );

  config
    .command("set <key> <value>")
    .description(
      "Set a config value (supports dotted paths like apiKeys.anthropic)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  key     Dotted path to the config key (e.g. provider, calls.enabled,
          apiKeys.anthropic). Intermediate objects are created automatically.
  value   The value to store. Parsed as JSON first (so "true" becomes boolean
          true, "42" becomes number 42). Falls back to plain string if JSON
          parsing fails.

After writing the value to config.json, the lockfile is automatically synced
to reflect the updated configuration.

Examples:
  $ assistant config set provider anthropic
  $ assistant config set calls.enabled true
  $ assistant config set apiKeys.anthropic sk-ant-abc123`,
    )
    .action((key: string, value: string) => {
      const raw = loadRawConfig();
      // Try to parse as JSON for booleans/numbers, fall back to string
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        // keep as string
      }
      setNestedValue(raw, key, parsed);
      saveRawConfig(raw);
      syncConfigToLockfile();
      log.info(`Set ${key} = ${JSON.stringify(parsed)}`);
    });

  config
    .command("get <key>")
    .description("Get a config value (supports dotted paths)")
    .addHelpText(
      "after",
      `
Arguments:
  key   Dotted path to the config key (e.g. provider, calls.enabled)

Prints the value at the given key path. If the key is not set, prints
"(not set)". Object values are pretty-printed as indented JSON.

Examples:
  $ assistant config get provider
  $ assistant config get calls.enabled
  $ assistant config get apiKeys`,
    )
    .action((key: string) => {
      const raw = loadRawConfig();
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
    .command("list")
    .description("List all config values")
    .option(
      "--search <query>",
      "Filter config entries by case-insensitive substring match on key name",
    )
    .addHelpText(
      "after",
      `
Dumps the full raw configuration from config.json as pretty-printed JSON.
If no configuration has been set, prints "No configuration set".

The --search flag filters results by case-insensitive substring match against
flattened dotted key paths. For example, --search api matches apiKeys.anthropic,
apiKeys.openai, and any other key containing "api".

Examples:
  $ assistant config list
  $ assistant config list --search api
  $ assistant config list --search calls`,
    )
    .action((opts: { search?: string }) => {
      const raw = loadRawConfig();
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
    .action(() => {
      const { validateAllowlistFile } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../../security/secret-allowlist.js") as typeof import("../../security/secret-allowlist.js");
      try {
        const errors = validateAllowlistFile();
        if (errors == null) {
          log.info("No secret-allowlist.json file found");
          return;
        }
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
      } catch (err) {
        log.error(
          `Failed to read secret-allowlist.json: ${(err as Error).message}`,
        );
        process.exit(1);
      }
    });
}
