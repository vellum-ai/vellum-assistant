import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

// ---------------------------------------------------------------------------
// CES shell lockdown guard
// ---------------------------------------------------------------------------

/**
 * Returns true when the current process is running inside an untrusted shell
 * (CES shell lockdown active). CLI commands that reveal raw tokens must
 * check this and fail deterministically.
 */
function isUntrustedShell(): boolean {
  return process.env.VELLUM_UNTRUSTED_SHELL === "1";
}

/** Error message for commands blocked by CES shell lockdown. */
const UNTRUSTED_SHELL_ERROR =
  "This command is not available in untrusted shell mode. " +
  "Raw token access is restricted when running under CES shell lockdown.";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerTokenCommand(oauth: Command): void {
  oauth
    .command("token <provider>")
    .description(
      'An escape hatch to retrieve a valid OAuth access token for a provider whose mode is "your-own" for direct use.',
    )
    .option(
      "--account <account>",
      "Account identifier for account disambiguation (e.g. user@gmail.com)",
    )
    .option(
      "--client-id <id>",
      "Filter by OAuth client ID when multiple OAuth apps exist for the provider",
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack).
             Run 'assistant oauth providers list' to see all available
             providers.

This command is discouraged and should be used sparingly. Only use if you
need direct access to the token (i.e. \`assistant oauth request\` is
insufficient) and you are comfortable with the security implications.

Token retrieval is only supported for providers with mode set to "your-own".
Platform-managed providers handle tokens internally — use
'assistant oauth ping <provider>' to verify connectivity or
'assistant oauth request --provider <provider> <url>' to make
authenticated requests.

Use 'assistant oauth status <provider>' to find account identifiers for
--account. Shell lockdown: blocked when VELLUM_UNTRUSTED_SHELL=1.

Examples:
  $ assistant oauth token google
  $ assistant oauth token twitter --json
  $ assistant oauth token google --account user@gmail.com
  $ assistant oauth token google --client-id abc123`,
    )
    .action(
      async (
        provider: string,
        opts: { account?: string; clientId?: string },
        cmd: Command,
      ) => {
        try {
          // CES shell lockdown — check on CLI side before hitting daemon
          if (isUntrustedShell()) {
            writeOutput(cmd, { ok: false, error: UNTRUSTED_SHELL_ERROR });
            process.exitCode = 1;
            return;
          }

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
