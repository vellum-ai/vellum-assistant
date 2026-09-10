/**
 * `assistant channels send`: post text to a chat on a channel, as the
 * assistant's own bot.
 *
 * The send door. It runs the daemon function the messaging tool runs
 * (`sendChannelText`, over `POST /v1/channels/send`), so a send from the
 * command line reaches the chat through the channel's transport and leaves
 * the same record: threaded where a thread is named, rendered the way the
 * channel renders a reply, and written to the chat's conversation only once
 * the channel has acknowledged it.
 *
 * Posting the same text through `channels request` reaches the platform API
 * directly and leaves no record of what was said, which is why this command
 * exists beside it. Both act as the bot and both carry the same rating: the
 * effect is a message either way.
 *
 * A channel whose transport cannot be addressed from a named chat is
 * refused by the route before anything is sent.
 */

import type { Command } from "commander";

import { cliIpcCall, exitCodeFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeError, writeOutput } from "../../output.js";

/** What the channel acknowledged, and where the post was recorded. */
interface ChannelSendResponse {
  channel: string;
  chatId: string;
  threadId?: string;
  messageIds: string[];
  lastMessageId: string;
  recordedIn?: string;
}

interface ChannelSendOptions {
  text?: string;
  thread?: string;
  plain?: boolean;
}

export function registerChannelsSendCommand(channels: Command): void {
  subcommand(channels, "send").action(
    async (
      channel: string,
      chatId: string,
      opts: ChannelSendOptions,
      cmd: Command,
    ) => {
      const text = opts.text?.trim();
      if (!text) {
        writeError(cmd, "--text is required and cannot be empty.");
        process.exitCode = 1;
        return;
      }

      const threadId = opts.thread?.trim();
      const r = await cliIpcCall<ChannelSendResponse>("channels_send_post", {
        body: {
          channel,
          target: {
            kind: "chat",
            chatId,
            ...(threadId ? { threadId } : {}),
          },
          text,
          // Rich unless asked otherwise, so a send from here reads like the
          // assistant's other posts in that chat rather than like a
          // different sender.
          ...(opts.plain ? {} : { renderRichly: true }),
        },
      });
      if (!r.ok) {
        // Reported rather than exited, so `--json` gets an error envelope
        // like every other answer this command gives.
        writeError(cmd, r.error ?? "The send failed.");
        process.exitCode = exitCodeFromIpcResult({
          statusCode: r.statusCode,
        });
        return;
      }

      const sent = r.result!;
      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, sent);
        return;
      }

      const where = sent.threadId
        ? `${sent.chatId}, thread ${sent.threadId}`
        : sent.chatId;
      log.info(`Sent to ${channel} ${where} (id: ${sent.lastMessageId})`);
      if (sent.messageIds.length > 1) {
        log.info(`The channel split it into ${sent.messageIds.length} posts`);
      }
      if (sent.recordedIn) {
        log.info(`Recorded in conversation ${sent.recordedIn}`);
      }
    },
  );
}
