import type { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { registerCommand } from "../../lib/register-command.js";
import { registerAppCommands } from "./apps.js";
import { registerConnectCommand } from "./connect.js";
import { registerDisconnectCommand } from "./disconnect.js";
import { oauthHelp } from "./index.help.js";
import { registerModeCommand } from "./mode.js";
import { registerPingCommand } from "./ping.js";
import { registerProviderCommands } from "./providers.js";
import { registerRequestCommand } from "./request.js";
import { registerStatusCommand } from "./status.js";
import { registerTokenCommand } from "./token.js";

export function registerOAuthCommand(program: Command): void {
  registerCommand(program, {
    name: oauthHelp.name,
    transport: "ipc",
    description: oauthHelp.description,
    build: (oauth) => {
      applyCommandHelp(oauth, oauthHelp);

      // -----------------------------------------------------------------------
      // providers — subcommand group
      // -----------------------------------------------------------------------

      registerProviderCommands(oauth);

      // -----------------------------------------------------------------------
      // mode — get or set OAuth mode (managed vs your-own) for a provider
      // -----------------------------------------------------------------------

      registerModeCommand(oauth);

      // -----------------------------------------------------------------------
      // apps — subcommand group
      // -----------------------------------------------------------------------

      registerAppCommands(oauth);

      // -----------------------------------------------------------------------
      // connect — unified connect command (auto-detects managed vs BYO)
      // -----------------------------------------------------------------------

      registerConnectCommand(oauth);

      // -----------------------------------------------------------------------
      // status — unified connection status
      // -----------------------------------------------------------------------

      registerStatusCommand(oauth);

      // -----------------------------------------------------------------------
      // ping — ping to see if a provider is connected and healthy
      // -----------------------------------------------------------------------

      registerPingCommand(oauth);

      // -----------------------------------------------------------------------
      // request — curl-like authenticated request command
      // -----------------------------------------------------------------------

      registerRequestCommand(oauth);

      // -----------------------------------------------------------------------
      // disconnect — unified disconnect with auto-detected managed/BYO routing
      // -----------------------------------------------------------------------

      registerDisconnectCommand(oauth);

      // -----------------------------------------------------------------------
      // token — retrieve a valid oauth token (your-own mode only)
      // -----------------------------------------------------------------------

      registerTokenCommand(oauth);
    },
  });
}
