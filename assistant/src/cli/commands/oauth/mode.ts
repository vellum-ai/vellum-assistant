import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerModeCommand(oauth: Command): void {
  oauth
    .command("mode <provider>")
    .description("Get or set the OAuth mode for a provider")
    .option(
      "--set <mode>",
      'Set the mode to "managed" (platform-handled credentials) or "your-own" (bring-your-own client ID and secret). Omit to show the current mode.',
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack).
             Run "assistant oauth providers list" to see available providers.

Modes:
  managed    OAuth credentials are managed by the Vellum platform. The
             assistant connects via a platform-hosted authorization flow.
             No local client ID or secret is needed.
  your-own   You supply your own OAuth app credentials (client ID and
             secret). The assistant runs the OAuth flow locally.

Examples:
  $ assistant oauth mode google
  $ assistant oauth mode google --set your-own
  $ assistant oauth mode google --set managed`,
    )
    .action(async (provider: string, opts: { set?: string }, cmd: Command) => {
      try {
        if (opts.set === undefined) {
          // GET mode
          const r = await cliIpcCall<{
            ok: boolean;
            provider: string;
            mode: string;
            managedModeSupported: boolean;
          }>("oauth_mode_get", {
            queryParams: { provider },
          });

          if (!r.ok) return exitFromIpcResult(r);

          const result = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, result);
          } else {
            if (!result.managedModeSupported) {
              log.info(
                `${provider} mode: your-own (managed mode not available for this provider)`,
              );
            } else {
              log.info(`${provider} mode: ${result.mode}`);
            }
          }
          return;
        }

        // SET mode
        const r = await cliIpcCall<{
          ok: boolean;
          provider: string;
          mode: string;
          changed: boolean;
          managedModeSupported: boolean;
          hint?: string;
        }>("oauth_mode_set", {
          body: { provider, mode: opts.set },
        });

        if (!r.ok) return exitFromIpcResult(r);

        const result = r.result!;

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, result);
        } else {
          if (!result.changed) {
            if (!result.managedModeSupported) {
              log.info(
                `${provider} is already set to your-own (managed mode not available for this provider)`,
              );
            } else {
              log.info(`${provider} is already set to ${result.mode}`);
            }
          } else {
            log.info(`${provider} mode changed to ${result.mode}`);
            if (result.hint) {
              process.stderr.write(result.hint + "\n");
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });
}
