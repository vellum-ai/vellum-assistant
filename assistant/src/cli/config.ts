import type { Command } from "commander";

import {
  getNestedValue,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../config/loader.js";
import { getCliLogger } from "../util/logger.js";

const log = getCliLogger("cli");

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Manage configuration");

  config
    .command("set <key> <value>")
    .description(
      "Set a config value (supports dotted paths like apiKeys.anthropic)",
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
      log.info(`Set ${key} = ${JSON.stringify(parsed)}`);
    });

  config
    .command("get <key>")
    .description("Get a config value (supports dotted paths)")
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
