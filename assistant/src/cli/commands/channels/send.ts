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

/**
 * How long to wait for the daemon before giving up on an answer.
 *
 * Longer than the IPC default because the work behind this call is a
 * platform request that retries: a rate-limited Slack send sleeps for the
 * `Retry-After` Slack names and tries again up to three times
 * (`MAX_RATE_LIMIT_RETRIES`, providers/slack/web-api-transport.ts), and the
 * other channels back off similarly. Waiting past that is better than
 * abandoning a send that is still being made, because giving up tells the
 * caller nothing about whether the message went out.
 */
const SEND_CALL_TIMEOUT_MS = 120_000;

export function registerChannelsSendCommand(channels: Command): void {
  subcommand(channels, "send").action(
    async (
      channel: string,
      chatId: string,
      opts: ChannelSendOptions,
      cmd: Command,
    ) => {
      // Trimmed only to reject a blank message: the text goes out as the
      // caller wrote it, which `--plain` in particular promises.
      const text = opts.text;
      if (!text?.trim()) {
        writeError(cmd, "--text is required and cannot be empty.");
        process.exitCode = 1;
        return;
      }

      const threadId = opts.thread?.trim();
      const r = await cliIpcCall<ChannelSendResponse>(
        "channels_send_post",
        {
          body: {
            channel,
            target: {
              kind: "chat",
              chatId,
              ...(threadId ? { threadId } : {}),
            },
            text,
            // Rich unless asked otherwise, so a send from here reads like
            // the assistant's other posts in that chat rather than like a
            // different sender.
            ...(opts.plain ? {} : { renderRichly: true }),
          },
        },
        { timeoutMs: SEND_CALL_TIMEOUT_MS },
      );
      if (!r.ok) {
        // A timeout is not a failure: closing the client socket does not
        // stop the daemon, so the message may still go out. Saying so is
        // what keeps a retry from posting it twice.
        const message = r.timedOut
          ? `The daemon did not answer within ${Math.round(SEND_CALL_TIMEOUT_MS / 1000)}s. The send may still be in flight, so it may or may not have gone out. Check the chat before sending again.`
          : (r.error ?? "The send failed.");
        // Reported rather than exited, so `--json` gets an error envelope
        // like every other answer this command gives.
        writeError(cmd, message);
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
