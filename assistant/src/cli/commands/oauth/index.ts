import type { Command } from "commander";

import { registerAppCommands } from "./apps.js";
import { registerConnectionCommands } from "./connections.js";
import { registerDisconnectCommand } from "./disconnect.js";
import { registerPlatformCommands } from "./platform.js";
import { registerProviderCommands } from "./providers.js";
import { registerRequestCommand } from "./request.js";

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
  platform    Platform-managed OAuth provider status and connections
  request     Make authenticated HTTP requests (curl-like interface)

Providers are seeded on startup for built-in integrations. Apps and connections
are created during the OAuth authorization flow or can be managed manually via
their respective subcommands.

Examples:
  $ assistant oauth request --provider integration:google /gmail/v1/users/me/messages
  $ assistant oauth request --provider integration:twitter -X POST -d '{"text":"Hello"}' https://api.x.com/2/tweets
  $ assistant oauth connections token integration:twitter
  $ assistant oauth connections list
  $ assistant oauth connections get --provider integration:google
  $ assistant oauth providers list
  $ assistant oauth providers get integration:google
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

  // ---------------------------------------------------------------------------
  // platform — subcommand group
  // ---------------------------------------------------------------------------

  registerPlatformCommands(oauth);

  // ---------------------------------------------------------------------------
  // request — curl-like authenticated request command
  // ---------------------------------------------------------------------------

  registerRequestCommand(oauth);

  // ---------------------------------------------------------------------------
  // disconnect — unified disconnect with auto-detected managed/BYO routing
  // ---------------------------------------------------------------------------

  registerDisconnectCommand(oauth);
}
