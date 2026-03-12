import type { Command } from "commander";

import { withValidToken } from "../../security/token-manager.js";
import { shouldOutputJson, writeOutput } from "../output.js";

export function registerOAuthCommand(program: Command): void {
  const oauth = program
    .command("oauth")
    .description("Manage OAuth tokens for connected integrations")
    .option("--json", "Machine-readable compact JSON output");

  oauth.addHelpText(
    "after",
    `
OAuth tokens are managed automatically — the "token" command returns a
guaranteed-valid access token, refreshing transparently if the stored token
is expired or near-expiry. Callers never need to handle refresh themselves.

The <service> argument is the short integration name (e.g. "twitter", "gmail",
"slack"). The token is resolved from the corresponding OAuth connection.

Examples:
  $ assistant oauth token twitter
  $ assistant oauth token twitter --json
  $ TOKEN=$(assistant oauth token gmail)
  $ curl -H "Authorization: Bearer $(assistant oauth token twitter)" https://api.x.com/2/tweets`,
  );

  // ---------------------------------------------------------------------------
  // token — return a guaranteed-valid access token
  // ---------------------------------------------------------------------------

  oauth
    .command("token <service>")
    .description(
      "Print a valid OAuth access token for a service, refreshing if expired",
    )
    .addHelpText(
      "after",
      `
Arguments:
  service   Integration name without the "integration:" prefix
            (e.g. "twitter", "gmail", "slack")

Returns a valid OAuth access token for the given service. If the stored token
is expired or near-expiry, it is refreshed automatically before being returned.
The refresh uses the stored refresh token and OAuth2 configuration from
credential metadata — no additional input is required.

In human mode, prints the bare token to stdout (suitable for shell substitution).
In JSON mode (--json), prints {"ok": true, "token": "..."}.

Exits with code 1 if no access token exists for the service, no refresh token
is available, or the token refresh fails (e.g. revoked credentials).

Examples:
  $ assistant oauth token twitter
  $ assistant oauth token gmail --json
  $ export TOKEN=$(assistant oauth token twitter)`,
    )
    .action(async (service: string, _opts: unknown, cmd: Command) => {
      try {
        const qualifiedService = `integration:${service}`;
        const token = await withValidToken(qualifiedService, async (t) => t);

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
    });
}
