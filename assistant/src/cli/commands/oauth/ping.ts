import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPingCommand(oauth: Command): void {
  oauth
    .command("ping <provider>")
    .description(
      "Verify an OAuth token is valid by hitting the provider's configured health-check endpoint",
    )
    .option("--account <account>", "Account identifier for multi-account")
    .option("--client-id <id>", "BYO app client ID disambiguation")
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack).
             Run 'assistant oauth providers list' to see available providers.

Hits the provider's configured ping URL with the stored OAuth token and
reports whether the token is valid. Use 'assistant oauth status <provider>'
to find account identifiers for --account.

Examples:
  $ assistant oauth ping google
  $ assistant oauth ping google --json
  $ assistant oauth ping google --account user@example.com`,
    )
    .action(
      async (
        provider: string,
        opts: {
          account?: string;
          clientId?: string;
        },
        cmd: Command,
      ) => {
        const jsonMode = shouldOutputJson(cmd);

        try {
          const body: Record<string, unknown> = { provider };
          if (opts.account) body.account = opts.account;
          if (opts.clientId) body.client_id = opts.clientId;

          const r = await cliIpcCall<{
            ok: boolean;
            provider: string;
            status: number;
            error?: string;
            hint?: string;
          }>("oauth_ping", { body });

          if (!r.ok) return exitFromIpcResult(r);

          const result = r.result!;

          if (result.ok) {
            if (!jsonMode) {
              log.info(`${provider}: OK (HTTP ${result.status})`);
            }
            writeOutput(cmd, result);
          } else {
            writeOutput(cmd, result);
            process.exitCode = 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);

          writeOutput(cmd, {
            ok: false,
            error: message,
            hint:
              `Run 'assistant oauth status ${provider}' to check connection health. ` +
              `To reconnect, run 'assistant oauth connect --help'.`,
          });
          process.exitCode = 1;
        }
      },
    );
}
