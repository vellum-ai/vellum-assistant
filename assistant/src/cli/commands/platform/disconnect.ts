import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

export function registerPlatformDisconnectCommand(platform: Command): void {
  platform
    .command("disconnect")
    .description(
      "Disconnect from the Vellum Platform by removing stored credentials",
    )
    .addHelpText(
      "after",
      `
Removes all stored platform credentials from the assistant's secure
credential store. After disconnecting, platform-managed features (managed
proxy, managed OAuth, callback routing) will no longer be available until
you reconnect with 'assistant platform connect'.

Use 'assistant platform status' to check the current connection state
before disconnecting.

Examples:
  $ assistant platform disconnect
  $ assistant platform disconnect --json`,
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const r = await cliIpcCall<{
        disconnected: boolean;
        previousBaseUrl: string | null;
      }>("platform_disconnect", {});
      if (!r.ok) return exitFromIpcResult({ ok: false, error: r.error, statusCode: r.statusCode }, cmd);

      writeOutput(cmd, { ok: true, ...r.result });

      if (!shouldOutputJson(cmd)) {
        const prev = r.result?.previousBaseUrl;
        log.info(
          `Disconnected from platform${prev ? ` at ${prev}` : ""}`,
        );
      }
    });
}
