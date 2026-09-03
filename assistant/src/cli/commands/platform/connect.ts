import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import type { PlatformConnectResponse } from "../../../runtime/routes/platform-routes.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

export function registerPlatformConnectCommand(platform: Command): void {
  subcommand(platform, "connect").action(
    async (_opts: Record<string, unknown>, cmd: Command) => {
      const r = await cliIpcCall<PlatformConnectResponse>(
        "platform_connect",
        {},
      );
      if (!r.ok) {
        return exitFromIpcResult(
          { ok: false, error: r.error, statusCode: r.statusCode },
          cmd,
        );
      }

      writeOutput(cmd, { ok: true, ...r.result });

      if (!shouldOutputJson(cmd)) {
        if (r.result?.alreadyConnected) {
          log.info(
            `Already connected to platform at ${r.result.baseUrl}. ` +
              `Run 'assistant platform disconnect' first to reconnect.`,
          );
        } else if (r.result?.credentialRejected) {
          // No client shows a login screen for the daemon's signal, so this
          // line is what tells the user what replaces the key. A plain sign-in
          // stops at "already logged in" before the credential pass runs;
          // --force runs it.
          log.info(
            "The stored platform credential was rejected by the platform. " +
              "Run 'vellum login --force' to sign in again and replace it.",
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
