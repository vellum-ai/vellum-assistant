import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerTokenCommand(oauth: Command): void {
  subcommand(oauth, "token").action(
    async (
      provider: string,
      opts: { account?: string; clientId?: string },
      cmd: Command,
    ) => {
      try {
        const body: Record<string, unknown> = { provider };
        if (opts.account) body.account = opts.account;
        if (opts.clientId) body.client_id = opts.clientId;

        const r = await cliIpcCall<{ ok: boolean; token: string }>(
          "oauth_token",
          { body },
        );

        if (!r.ok) return exitFromIpcResult(r);

        const result = r.result!;

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, result);
        } else {
          process.stdout.write(result.token + "\n");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    },
  );
}
