import type { Command } from "commander";

import { registerCommand } from "../../lib/register-command.js";
import { registerSlackCommand } from "./slack/index.js";

export function registerUseCommand(program: Command): void {
  registerCommand(program, {
    name: "use",
    transport: "ipc",
    description: "Use third-party integrations (Slack, Linear, etc.)",
    build: (use) => {
      use.addHelpText(
        "after",
        `
Third-party integration commands. Each integration is a subcommand
group with its own set of operations. Integrations require prior
configuration via 'assistant oauth' or 'assistant credentials'.

Examples:
  $ assistant use slack send --channel general --text "hello"
  $ assistant use slack read --channel general --limit 5
  $ assistant use slack channels list`,
      );

      registerSlackCommand(use);
    },
  });
}
