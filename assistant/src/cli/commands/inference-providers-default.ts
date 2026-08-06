/**
 * `assistant inference providers default [name]` — read or set the workspace
 * default provider (`llm.defaultProvider`), wrapping the daemon's
 * `llm_default_provider_get` / `llm_default_provider_put` routes. The read
 * form prints the resolved connection and its availability status.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { subcommand } from "../lib/cli-command-help.js";
import { writeCliError, writeLine } from "../lib/cli-output.js";

interface DefaultProviderStatus {
  provider: string | null;
  connectionName?: string;
  resolvedConnectionName: string | null;
  availability: { status: string; message?: string };
}

function printStatus(status: DefaultProviderStatus, json?: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, ...status }) + "\n");
    return;
  }
  if (!status.provider) {
    writeLine("no default provider configured");
  } else {
    writeLine(`default provider: ${status.provider}`);
    if (status.resolvedConnectionName) {
      writeLine(`  connection: ${status.resolvedConnectionName}`);
    }
  }
  writeLine(`  availability: ${status.availability.status}`);
  if (status.availability.message) {
    writeLine(`    ${status.availability.message}`);
  }
}

export function attachDefaultProviderSubcommand(providers: Command): void {
  subcommand(providers, "default").action(
    async (
      name: string | undefined,
      opts: { connection?: string; json?: boolean },
    ) => {
      if (name === undefined) {
        const ipcResult = await cliIpcCall<DefaultProviderStatus>(
          "llm_default_provider_get",
          {},
        );
        if (!ipcResult.ok) {
          writeCliError(ipcResult.error ?? "Unknown error", opts.json);
          return;
        }
        printStatus(ipcResult.result!, opts.json);
        return;
      }

      const body: Record<string, unknown> = { provider: name };
      if (opts.connection !== undefined) {
        body.connectionName = opts.connection;
      }
      const ipcResult = await cliIpcCall<DefaultProviderStatus>(
        "llm_default_provider_put",
        { body },
      );
      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }
      printStatus(ipcResult.result!, opts.json);
    },
  );
}
