import type { Command } from "commander";

import { registerCommand } from "../../../lib/register-command.js";
import { registerChannelsCommand } from "./channels.js";
import { registerReactCommand } from "./react.js";
import { registerReadCommand } from "./read.js";
import { registerSendCommand } from "./send.js";
import { registerUsersCommand } from "./users.js";

export function registerSlackCommand(parent: Command): void {
  registerCommand(parent, {
    name: "slack",
    transport: "ipc",
    description: "Send, read, and react to Slack messages",
    build: (slack) => {
      slack.option("--json", "Machine-readable compact JSON output");

      slack.addHelpText(
        "after",
        `
Slack integration requires a configured Slack token. Set one up via
'assistant oauth connect slack' or 'assistant credentials set slack-token'.

Channel arguments accept a channel name (with or without #) or a raw
Slack channel ID. User arguments accept an email address or display name.

Examples:
  $ assistant use slack send --channel team-jarvis --text "hello"
  $ assistant use slack read --channel general --limit 10 --since 2h
  $ assistant use slack react --channel general --ts 1715123456.000100 --emoji thumbsup
  $ assistant use slack channels list
  $ assistant use slack channels refresh
  $ assistant use slack users get user@example.com`,
      );

      registerSendCommand(slack);
      registerReadCommand(slack);
      registerReactCommand(slack);
      registerChannelsCommand(slack);
      registerUsersCommand(slack);
    },
  });
}
