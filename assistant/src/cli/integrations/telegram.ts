import type { Command } from "commander";

import { gatewayGet, runRead } from "./utils.js";

export function registerTelegramSubcommand(integrations: Command): void {
  const telegram = integrations
    .command("telegram")
    .description("Telegram integration status");

  telegram.addHelpText(
    "after",
    `
Checks the Telegram bot configuration status through the gateway API.
Requires the assistant to be running.

Examples:
  $ assistant integrations telegram config
  $ assistant integrations telegram config --json`,
  );

  telegram
    .command("config")
    .description("Get Telegram integration configuration status")
    .addHelpText(
      "after",
      `
Returns the Telegram bot token status, webhook URL, and bot username from
the gateway. Requires the assistant to be running.

The response includes whether a bot token is configured, the current webhook
endpoint, and the bot's Telegram username.

Examples:
  $ assistant integrations telegram config
  $ assistant integrations telegram config --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () =>
        gatewayGet("/v1/integrations/telegram/config"),
      );
    });
}
