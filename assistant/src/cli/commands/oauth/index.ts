import type { Command } from "commander";

import { registerAppCommands } from "./apps.js";
import { registerConnectCommand } from "./connect.js";
import { registerConnectionCommands } from "./connections.js";
import { registerDisconnectCommand } from "./disconnect.js";
import { registerPlatformCommands } from "./platform.js";
import { registerProviderCommands } from "./providers.js";
import { registerRequestCommand } from "./request.js";
import { registerStatusCommand } from "./status.js";
import { registerTokenCommand } from "./token.js";

export function registerOAuthCommand(program: Command): void {
  const oauth = program
    .command("oauth")
    .description("Manage OAuth providers, apps, connections, and tokens")
    .option("--json", "Machine-readable compact JSON output");

  oauth.addHelpText(
    "after",
    `
The oauth command group manages the full OAuth lifecycle:

  connect     Initiate an OAuth flow for a provider (managed or BYO)
  disconnect  Disconnect an OAuth provider
  status      Show OAuth connection status for a provider
  token       Print a valid OAuth access token (BYO providers only)
  request     Make authenticated HTTP requests (curl-like interface)
  providers   Protocol-level configurations (auth URLs, scopes, endpoints)
  apps        Client credentials (client ID / secret pairs)
  connections Active token grants per provider (deprecated)
  platform    Platform-managed OAuth provider status and connections (deprecated)

Providers are seeded on startup for built-in integrations. Apps and connections
are created during the OAuth authorization flow or can be managed manually via
their respective subcommands.

Examples:
  $ assistant oauth connect google --open-browser
  $ assistant oauth status google
  $ assistant oauth disconnect google
  $ assistant oauth request --provider integration:google /gmail/v1/users/me/messages
  $ assistant oauth request --provider integration:twitter -X POST -d '{"text":"Hello"}' https://api.x.com/2/tweets
  $ assistant oauth token integration:twitter
  $ assistant oauth connections token integration:twitter
  $ assistant oauth providers list
  $ assistant oauth providers get integration:google`,
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
  // connect — unified connect command (auto-detects managed vs BYO)
  // ---------------------------------------------------------------------------

  registerConnectCommand(oauth);

  // ---------------------------------------------------------------------------
  // disconnect — unified disconnect with auto-detected managed/BYO routing
  // ---------------------------------------------------------------------------

  registerDisconnectCommand(oauth);

  // ---------------------------------------------------------------------------
  // status — unified connection status (auto-detects managed vs BYO)
  // ---------------------------------------------------------------------------

  registerStatusCommand(oauth);

  // ---------------------------------------------------------------------------
  // token — unified token retrieval (BYO only, managed-mode guard)
  // ---------------------------------------------------------------------------

  registerTokenCommand(oauth);
}
