import type { Command } from "commander";

import { getActiveConnection } from "../../../oauth/oauth-store.js";
import { withValidToken } from "../../../security/token-manager.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { isManagedMode } from "./shared.js";

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

Options:
  --account <account>   Select a specific account when multiple connections
                        exist for the same provider. Uses the account label
                        shown in 'assistant oauth status <provider>'.
  --client-id <id>      Select a specific OAuth app when multiple apps exist
                        for the same provider.


This command is discouraged from use and should be used sparingly. Only use
if you need direct access to the token (i.e. \`assistant oauth request\` is
insufficient for your use case) and you are comfortable with the potential
security implications of exposing this token.

Token retrieval is only supported for providers with mode set to "your-own".
Platform-managed providers handle tokens internally — use
'assistant oauth ping <provider>' to verify connectivity or
'assistant oauth request --provider <provider> <url>' to make
authenticated requests.

Shell lockdown: This command is blocked when running in an untrusted
shell (VELLUM_UNTRUSTED_SHELL=1) to prevent token exfiltration.

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
          // ---------------------------------------------------------------
          // 1. Check managed mode
          // ---------------------------------------------------------------
          if (isManagedMode(provider)) {
            const message =
              "Token retrieval is not supported for platform-managed providers. " +
              "When a provider is in managed mode, Vellum handles OAuth tokens on your behalf — " +
              "they are not exposed directly.\n\n" +
              `To verify your connection is working, run 'assistant oauth ping ${provider}'.\n` +
              `To make authenticated requests, use 'assistant oauth request --provider ${provider} <url>'.`;
            writeOutput(cmd, { ok: false, error: message });
            process.exitCode = 1;
            return;
          }

          // ---------------------------------------------------------------
          // 3. CES shell lockdown
          // ---------------------------------------------------------------
          if (isUntrustedShell()) {
            writeOutput(cmd, { ok: false, error: UNTRUSTED_SHELL_ERROR });
            process.exitCode = 1;
            return;
          }

          // ---------------------------------------------------------------
          // 4. Resolve connection and retrieve token (BYO mode)
          // ---------------------------------------------------------------

          // When --account or --client-id is provided, resolve the active
          // connection first to disambiguate, then use the connection ID
          // with withValidToken.
          let tokenOpts: string | { connectionId: string } | undefined;

          if (opts.account || opts.clientId) {
            const conn = getActiveConnection(provider, {
              clientId: opts.clientId,
              account: opts.account,
            });
            if (!conn) {
              const hint = opts.account
                ? ` for account "${opts.account}"`
                : opts.clientId
                  ? ` with client ID "${opts.clientId}"`
                  : "";
              const message =
                `No active connection found for "${provider}"${hint}. ` +
                `Connect first with 'assistant oauth connect ${provider}'.`;
              writeOutput(cmd, { ok: false, error: message });
              process.exitCode = 1;
              return;
            }
            tokenOpts = { connectionId: conn.id };
          }

          const token = await withValidToken(
            provider,
            async (t) => t,
            tokenOpts,
          );

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, token });
          } else {
            process.stdout.write(token + "\n");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
