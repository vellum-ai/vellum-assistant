import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDisconnectCommand(oauth: Command): void {
  oauth
    .command("disconnect <provider>")
    .description(
      "Disconnect an OAuth provider and remove associated credentials",
    )
    .option(
      "--account <identifier>",
      "Account identifier to disconnect (e.g. email address)",
    )
    .option("--connection-id <id>", "Exact connection ID to disconnect")
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack, notion).
             Run 'assistant oauth providers list' to see available providers.

At most one of --account or --connection-id may be specified. Use the values
shown by 'assistant oauth status <provider>' to find the right identifier.

When a provider has multiple active connections and neither flag is given,
the command errors with a list of connections and a hint to disambiguate.

Examples:
  $ assistant oauth disconnect google
  $ assistant oauth disconnect google --account user@gmail.com
  $ assistant oauth disconnect google --connection-id conn_abc123`,
    )
    .action(
      async (
        provider: string,
        opts: { account?: string; connectionId?: string },
        cmd: Command,
      ) => {
        const jsonMode = shouldOutputJson(cmd);

        const writeError = (
          error: string,
          extra?: Record<string, unknown>,
        ): void => {
          writeOutput(cmd, { ok: false, error, ...extra });
          process.exitCode = 1;
        };

        try {
          const body: Record<string, unknown> = { provider };
          if (opts.account) body.account = opts.account;
          if (opts.connectionId) body.connection_id = opts.connectionId;

          const r = await cliIpcCall<{
            ok: boolean;
            provider: string;
            connectionId: string;
            account?: string;
          }>("oauth_disconnect", { body });

          if (!r.ok) return exitFromIpcResult(r);

          const result = r.result!;
          writeOutput(cmd, result);

          if (!jsonMode) {
            log.info(
              `Disconnected ${result.provider} connection ${result.connectionId}`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(message);
        }
      },
    );
}
