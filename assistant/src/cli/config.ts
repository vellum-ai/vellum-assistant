import type { Command } from "commander";

import {
  getNestedValue,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
  syncConfigToLockfile,
} from "../config/loader.js";
import { getCliLogger } from "../util/logger.js";

const log = getCliLogger("cli");

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
  $ vellum config list
  $ vellum config get provider
  $ vellum config set provider anthropic
  $ vellum config set calls.enabled true`,
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
  $ vellum config set provider anthropic
  $ vellum config set calls.enabled true
  $ vellum config set apiKeys.anthropic sk-ant-abc123`,
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
  $ vellum config get provider
  $ vellum config get calls.enabled
  $ vellum config get apiKeys`,
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
    .addHelpText(
      "after",
      `
Dumps the full raw configuration from config.json as pretty-printed JSON.
If no configuration has been set, prints "No configuration set".

Examples:
  $ vellum config list`,
    )
    .action(() => {
      const raw = loadRawConfig();
      if (Object.keys(raw).length === 0) {
        log.info("No configuration set");
      } else {
        log.info(JSON.stringify(raw, null, 2));
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
  $ vellum config validate-allowlist`,
    )
    .action(() => {
      const { validateAllowlistFile } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../security/secret-allowlist.js") as typeof import("../security/secret-allowlist.js");
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
