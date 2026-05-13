import type { Command } from "commander";

import { startCli } from "../../cli.js";
import { shouldAutoStartDaemon } from "../../daemon/connection-policy.js";
import { ensureDaemonRunning } from "../../daemon/daemon-control.js";
import {
  findClosestCommand,
  formatUnknownCommandMessage,
} from "../lib/unknown-command.js";

export function registerDefaultAction(program: Command): void {
  program.action(async (_options: unknown, cmd: Command) => {
    // Commander routes unknown subcommands to the root action as positional
    // args instead of raising an error. Detect this case and fail with a
    // helpful message so users don't silently get the interactive CLI when
    // they mistype a command name.
    //
    // The `assistant <unknown> --help` path is intercepted earlier (see
    // src/index.ts) because Commander's `--help` short-circuit fires before
    // this action runs. This branch covers `assistant <unknown>` with no
    // `--help` flag.
    if (cmd.args.length > 0) {
      const unknown = cmd.args[0];
      const available = cmd.commands.map((c) => c.name());
      const suggestion = findClosestCommand(unknown, available);
      cmd.error(formatUnknownCommandMessage({ token: unknown, suggestion }), {
        code: "commander.unknownCommand",
        exitCode: 1,
      });
      return;
    }

    if (shouldAutoStartDaemon()) {
      await ensureDaemonRunning();
    }
    await startCli();
  });
}
