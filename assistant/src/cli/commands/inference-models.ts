/**
 * `assistant inference models` CLI namespace.
 *
 *   `assistant inference models list [--provider <p>] [--json]`
 *
 * Lists the code-owned model catalog so the assistant can discover valid
 * model ids instead of guessing. Delegates to the daemon via IPC
 * (`inference_models_list`).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { renderTable, writeCliError, writeLine } from "../lib/cli-output.js";

interface CatalogModel {
  provider: string;
  id: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  featureFlag?: string;
}

export function attachModelsSubcommand(inference: Command): void {
  const models = inference
    .command("models")
    .description("Inspect the inference model catalog");

  models
    .command("list")
    .description("List catalog models (optionally filtered by provider)")
    .option("--provider <p>", "Filter by provider id")
    .option("--json", "Output as machine-readable JSON")
    .addHelpText(
      "after",
      `
Lists every model in the code-owned provider catalog. Use the ids here
when creating an inference profile:

Examples:
  $ assistant inference models list
  $ assistant inference models list --provider anthropic
  $ assistant inference models list --json`,
    )
    .action(async (opts: { provider?: string; json?: boolean }) => {
      const ipcResult = await cliIpcCall<{ models: CatalogModel[] }>(
        "inference_models_list",
        { queryParams: opts.provider ? { provider: opts.provider } : {} },
      );

      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }

      const rows = ipcResult.result!.models;

      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, models: rows }) + "\n");
        return;
      }

      if (rows.length === 0) {
        writeLine("No models found.");
        return;
      }

      renderTable(
        ["PROVIDER", "MODEL ID", "DISPLAY NAME", "CONTEXT"],
        rows.map((m) => [
          m.provider,
          m.id,
          m.displayName,
          m.contextWindowTokens != null
            ? m.contextWindowTokens.toLocaleString()
            : "-",
        ]),
      );
    });
}
