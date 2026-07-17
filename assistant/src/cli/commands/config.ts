import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { getNestedValue } from "../lib/nested-value.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { configHelp } from "./config.help.js";

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
    name: configHelp.name,
    transport: "ipc",
    description: configHelp.description,
    build: (config) => {
      applyCommandHelp(config, configHelp);

      subcommand(config, "set").action(
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
            const { requirePlatformConnection } =
              await import("./oauth/shared.js");
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

      subcommand(config, "get").action(
        async (key: string, _opts: unknown, cmd: Command) => {
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
        },
      );

      subcommand(config, "schema").action(
        async (path: string | undefined, _opts: unknown, cmd: Command) => {
          const result = await cliIpcCall<{ schema: unknown }>(
            "config_schema_get",
            path ? { queryParams: { path } } : undefined,
          );
          if (!result.ok) {
            exitFromIpcResult(result, cmd);
            return;
          }
          log.info(JSON.stringify(result.result?.schema ?? {}, null, 2));
        },
      );

      subcommand(config, "list").action(
        async (opts: { search?: string }, cmd: Command) => {
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
        },
      );

      subcommand(config, "validate-allowlist").action(
        async (_opts: unknown, cmd: Command) => {
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
        },
      );
    },
  });
}
