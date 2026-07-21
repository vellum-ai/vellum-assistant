import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDisconnectCommand(oauth: Command): void {
  subcommand(oauth, "disconnect").action(
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
