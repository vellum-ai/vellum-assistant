import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../../ipc/cli-client.js";
import { getCliLogger } from "../../../logger.js";
import { shouldOutputJson, writeOutput } from "../../../output.js";

const log = getCliLogger("use:slack:send");

interface SendResponse {
  ok: boolean;
  channel: string;
  ts: string;
}

export function registerSendCommand(slack: Command): void {
  slack
    .command("send")
    .description("Send a message to a Slack channel or user DM")
    .requiredOption("--text <message>", "Message text to send")
    .option(
      "--channel <name-or-id>",
      "Channel name or ID — run 'assistant use slack channels list' to find it",
    )
    .option(
      "--user <id-or-email>",
      "User ID or email for a direct message — run 'assistant use slack users get <query>' to resolve",
    )
    .option("--thread <ts>", "Thread timestamp to reply in")
    .addHelpText(
      "after",
      `
Send a message to a Slack channel or open a DM with a user. Exactly
one of --channel or --user must be provided.

When --thread is given, the message is posted as a threaded reply.

Arguments:
  --text       The message body (required)
  --channel    Channel name (e.g. "general", "#team-jarvis") or Slack ID
  --user       User email or Slack user ID — opens a DM conversation
  --thread     Parent message timestamp for threading

Examples:
  $ assistant use slack send --channel team-jarvis --text "hello"
  Message sent to team-jarvis (ts: 1715123456.000100)

  $ assistant use slack send --user user@example.com --text "hey!"
  Message sent to user@example.com (ts: 1715123456.000200)

  $ assistant use slack send --channel general --text "reply" --thread 1715123456.000100
  Message sent to general (ts: 1715123456.000300)

  $ assistant use slack send --channel general --text "hello" --json
  {"ok":true,"channel":"C123","ts":"1715123456.000100"}`,
    )
    .action(
      async (
        opts: {
          text: string;
          channel?: string;
          user?: string;
          thread?: string;
        },
        cmd: Command,
      ) => {
        const { text, channel, user, thread } = opts;

        if ((channel && user) || (!channel && !user)) {
          log.error(
            "Exactly one of --channel or --user must be provided. Use --channel for a channel message or --user for a DM.",
          );
          process.exitCode = 1;
          return;
        }

        const r = await cliIpcCall<SendResponse>("slack_use_send", {
          body: { channel, user, text, thread },
        });
        if (!r.ok) return exitFromIpcResult(r, cmd);

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, r.result);
        } else {
          const target = channel ?? user;
          log.info(`Message sent to ${target} (ts: ${r.result!.ts})`);
        }
      },
    );
}
