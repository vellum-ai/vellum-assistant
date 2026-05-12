import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../../ipc/cli-client.js";
import { getCliLogger } from "../../../logger.js";
import { shouldOutputJson, writeOutput } from "../../../output.js";

const log = getCliLogger("use:slack:react");

export function registerReactCommand(slack: Command): void {
  slack
    .command("react")
    .description("Add an emoji reaction to a Slack message")
    .requiredOption(
      "--channel <name-or-id>",
      "Channel name or ID — run 'assistant use slack channels list' to find it",
    )
    .requiredOption(
      "--ts <message-ts>",
      "Timestamp of the message to react to — visible in 'assistant use slack read --json' output",
    )
    .requiredOption(
      "--emoji <name>",
      'Emoji name without colons (e.g. "thumbsup", not ":thumbsup:")',
    )
    .addHelpText(
      "after",
      `
Add an emoji reaction to a specific message in a Slack channel.
Surrounding colons on the emoji name are stripped automatically.

Arguments:
  --channel   Channel name or Slack channel ID (required)
  --ts        Message timestamp to react to (required)
  --emoji     Emoji name, e.g. "thumbsup", "rocket", "eyes" (required)

Examples:
  $ assistant use slack react --channel general --ts 1715123456.000100 --emoji thumbsup
  Reacted with :thumbsup: to message

  $ assistant use slack react --channel team-jarvis --ts 1715123456.000100 --emoji rocket --json
  {"ok":true}`,
    )
    .action(
      async (
        opts: { channel: string; ts: string; emoji: string },
        cmd: Command,
      ) => {
        const { channel, ts, emoji } = opts;

        const r = await cliIpcCall<{ ok: boolean }>("slack_use_react", {
          body: { channel, ts, emoji },
        });
        if (!r.ok) return exitFromIpcResult(r, cmd);

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, r.result);
        } else {
          log.info(
            `Reacted with :${emoji.replace(/^:/, "").replace(/:$/, "")}: to message`,
          );
        }
      },
    );
}
