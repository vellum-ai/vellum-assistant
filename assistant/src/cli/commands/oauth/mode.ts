import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerModeCommand(oauth: Command): void {
  subcommand(oauth, "mode").action(
    async (provider: string, opts: { set?: string }, cmd: Command) => {
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
    },
  );
}
