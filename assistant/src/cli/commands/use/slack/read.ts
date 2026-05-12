import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../../ipc/cli-client.js";
import { getCliLogger } from "../../../logger.js";
import { shouldOutputJson, writeOutput } from "../../../output.js";

const log = getCliLogger("use:slack:read");

interface ReadResponse {
  channel: string;
  messages: Array<{
    ts: string;
    user?: string;
    text: string;
    thread_ts?: string;
  }>;
}

export function registerReadCommand(slack: Command): void {
  slack
    .command("read")
    .description("Read messages from a Slack channel or thread")
    .requiredOption(
      "--channel <name-or-id>",
      "Channel name or ID — run 'assistant use slack channels list' to find it",
    )
    .option("--limit <n>", "Maximum number of messages to return", "20")
    .option(
      "--since <ts-or-offset>",
      'Only show messages since this point — a Slack timestamp (e.g. "1234567890.123456") or relative offset ("2h", "30m", "1d")',
    )
    .option("--thread <ts>", "Read replies in a specific thread")
    .addHelpText(
      "after",
      `
Read recent messages from a Slack channel. When --thread is given,
reads replies in that thread instead of top-level messages.

The --since option accepts either a raw Slack timestamp or a relative
offset: "2h" (2 hours ago), "30m" (30 minutes ago), "1d" (1 day ago).

Arguments:
  --channel   Channel name (e.g. "general") or Slack channel ID (required)
  --limit     Max messages to return (default: 20)
  --since     Filter to messages after this point
  --thread    Parent message timestamp to read thread replies

Examples:
  $ assistant use slack read --channel general
  [1715123456.000100] <U123> hello world
  [1715123456.000200] <U456> hi there

  $ assistant use slack read --channel team-jarvis --limit 5 --since 2h
  [1715123456.000100] <U123> recent message

  $ assistant use slack read --channel general --thread 1715123456.000100
  [1715123456.000100] <U123> original message
  [1715123456.000200] <U456> thread reply

  $ assistant use slack read --channel general --json
  {"channel":"C123","messages":[...]}`,
    )
    .action(
      async (
        opts: {
          channel: string;
          limit?: string;
          since?: string;
          thread?: string;
        },
        cmd: Command,
      ) => {
        const { channel, limit, since, thread } = opts;

        const r = await cliIpcCall<ReadResponse>("slack_use_read", {
          body: {
            channel,
            limit: parseInt(limit ?? "20", 10),
            since,
            thread,
          },
        });
        if (!r.ok) return exitFromIpcResult(r, cmd);

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, r.result);
        } else {
          const messages = r.result!.messages;
          if (messages.length === 0) {
            log.info("No messages found.");
          } else {
            for (const msg of messages) {
              const threadIndicator = msg.thread_ts ? " [thread]" : "";
              log.info(
                `[${msg.ts}] <${msg.user ?? "unknown"}> ${msg.text}${threadIndicator}`,
              );
            }
          }
        }
      },
    );
}
