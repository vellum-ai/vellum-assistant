import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

export function registerPlatformConnectCommand(platform: Command): void {
  subcommand(platform, "connect").action(
    async (_opts: Record<string, unknown>, cmd: Command) => {
      const r = await cliIpcCall<{
        alreadyConnected?: boolean;
        baseUrl?: string;
        showPlatformLogin?: boolean;
      }>("platform_connect", {});
      if (!r.ok)
        return exitFromIpcResult(
          { ok: false, error: r.error, statusCode: r.statusCode },
          cmd,
        );

      writeOutput(cmd, { ok: true, ...r.result });

      if (!shouldOutputJson(cmd)) {
        if (r.result?.alreadyConnected) {
          log.info(
            `Already connected to platform at ${r.result.baseUrl}. ` +
              `Run 'assistant platform disconnect' first to reconnect.`,
          );
        } else {
          log.info(
            "Showing the platform login screen on connected clients. " +
              "Please complete the sign-in flow in the app.",
          );
        }
      }
    },
  );
}
