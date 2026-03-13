import type { Command } from "commander";

import { registerAppCommands } from "./apps.js";
import { registerConnectionCommands } from "./connections.js";
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
  connections Active token grants per provider (list, get, token, disconnect)

Providers are seeded on startup for built-in integrations. Apps and connections
are created during the OAuth authorization flow or can be managed manually via
their respective subcommands.

Examples:
  $ assistant oauth connections token integration:twitter
  $ assistant oauth connections list
  $ assistant oauth connections get --provider integration:gmail
  $ assistant oauth providers list
  $ assistant oauth providers get integration:gmail
  $ assistant oauth providers register --provider-key custom:myapi --auth-url https://example.com/auth --token-url https://example.com/token`,
  );

  // ---------------------------------------------------------------------------
  // providers — subcommand group
  // ---------------------------------------------------------------------------

  registerProviderCommands(oauth);

  // ---------------------------------------------------------------------------
  // apps — subcommand group
  // ---------------------------------------------------------------------------

  registerAppCommands(oauth);

  // ---------------------------------------------------------------------------
  // connections — subcommand group (includes token)
  // ---------------------------------------------------------------------------

  registerConnectionCommands(oauth);
}
