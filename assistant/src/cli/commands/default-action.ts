import type { Command } from "commander";

import { startCli } from "../../cli.js";
import { shouldAutoStartDaemon } from "../../daemon/connection-policy.js";
import { ensureDaemonRunning } from "../../daemon/lifecycle.js";

export function registerDefaultAction(program: Command): void {
  program.action(async () => {
    if (shouldAutoStartDaemon()) {
      await ensureDaemonRunning();
    }
    await startCli();
  });
}
