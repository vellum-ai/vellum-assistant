import type { Command } from "commander";

import { withValidToken } from "../../../security/token-manager.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { registerProviderCommands } from "./providers.js";

export function registerOAuthCommand(program: Command): void {
  const oauth = program
    .command("oauth")
    .description("Manage OAuth providers, apps, connections, and tokens")
    .option("--json", "Machine-readable compact JSON output");

  oauth.addHelpText(
    "after",
    `
The oauth command group manages the full OAuth lifecycle:

  providers   Protocol-level configurations (auth URLs, scopes, endpoints)
  apps        Client credentials (client ID / secret pairs)
  connections Active token grants per provider
  token       Return a guaranteed-valid access token for a service

Providers are seeded on startup for built-in integrations. Apps and connections
are created during the OAuth authorization flow or can be managed manually via
their respective subcommands.

Examples:
  $ assistant oauth token twitter
  $ assistant oauth providers list
  $ assistant oauth providers get integration:gmail
  $ assistant oauth providers register --provider-key custom:myapi --auth-url https://example.com/auth --token-url https://example.com/token`,
  );

  // ---------------------------------------------------------------------------
  // providers — subcommand group
  // ---------------------------------------------------------------------------

  registerProviderCommands(oauth);

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
the OAuth connection store — no additional input is required.

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
