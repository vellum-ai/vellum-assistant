import type { Command } from "commander";

import { registerAppCommands } from "./apps.js";
import { registerConnectCommand } from "./connect.js";
import { registerDisconnectCommand } from "./disconnect.js";
import { registerModeCommand } from "./mode.js";
import { registerPingCommand } from "./ping.js";
import { registerProviderCommands } from "./providers.js";
import { registerRequestCommand } from "./request.js";
import { registerStatusCommand } from "./status.js";
import { registerTokenCommand } from "./token.js";

export function registerOAuthCommand(program: Command): void {
  const oauth = program
    .command("oauth")
    .description(
      "Manage the full OAuth lifecycle — registering providers, creating apps, connecting accounts, and making authenticated requests",
    )
    .option("--json", "Machine-readable compact JSON output");

  oauth.addHelpText(
    "after",
    `
OAuth providers may support up to two modes – "managed" and "your-own".
  managed:
    Requires a Vellum Platform account. For providers that support it, managed mode offloads the burden of needing to create and register an oauth app.
    Vellum Platform manages oauth token management and refresh and proxies requests to the provier.
  you-own:
    Provides ultimate control and removes dependency on Vellum Platform, but requires that you set up your own oauth app and register it
    via \`assistant oauth apps upsert\`.
All commands are intended to work regardless of the provider's mode. Check and set the mode for a given provider with \`assistant oauth mode\`.

You can define entirely new oauth providers to integrate with even if they do not show up using \`assistant oauth providers list\` using
\`assistant oauth providers register\`. Custom-registered providers only support "your-own" mode.


Examples:
  assistant oauth providers list
  assistant oauth providers get google
  assistant oauth mode google --set=managed
  assistant oauth connect google --open-browser
  assistant oauth status google
  assistant oauth ping google
  assistant oauth request --provider google /gmail/v1/users/me/messages
  assistant oauth disconnect google`,
  );

  // ---------------------------------------------------------------------------
  // providers — subcommand group
  // ---------------------------------------------------------------------------

  registerProviderCommands(oauth);

  // ---------------------------------------------------------------------------
  // mode — get or set OAuth mode (managed vs your-own) for a provider
  // ---------------------------------------------------------------------------

  registerModeCommand(oauth);

  // ---------------------------------------------------------------------------
  // apps — subcommand group
  // ---------------------------------------------------------------------------

  registerAppCommands(oauth);

  // ---------------------------------------------------------------------------
  // connect — unified connect command (auto-detects managed vs BYO)
  // ---------------------------------------------------------------------------

  registerConnectCommand(oauth);

  // ---------------------------------------------------------------------------
  // status — unified connection status
  // ---------------------------------------------------------------------------

  registerStatusCommand(oauth);

  // ---------------------------------------------------------------------------
  // ping — ping to see if a provider is connected and healthy
  // ---------------------------------------------------------------------------

  registerPingCommand(oauth);

  // ---------------------------------------------------------------------------
  // request — curl-like authenticated request command
  // ---------------------------------------------------------------------------

  registerRequestCommand(oauth);

  // ---------------------------------------------------------------------------
  // disconnect — unified disconnect with auto-detected managed/BYO routing
  // ---------------------------------------------------------------------------

  registerDisconnectCommand(oauth);

  // ---------------------------------------------------------------------------
  // token — retrieve a valid oauth token (your-own mode only)
  // ---------------------------------------------------------------------------

  registerTokenCommand(oauth);
}
