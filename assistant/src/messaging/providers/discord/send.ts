/**
 * Discord outbound message orchestration.
 *
 * Splits replies into Discord-sized chunks (see ./render.ts) and uploads
 * attachments, by calling the Discord REST API directly via ./api.ts.
 */

import { getAttachmentContent } from "../../../persistence/attachments-store.js";
import type { RuntimeAttachmentMetadata } from "../../../runtime/http-types.js";
import { getLogger } from "../../../util/logger.js";
import {
  callDiscordApi,
  callDiscordApiMultipart,
  type DiscordMessage,
  DiscordNonRetryableError,
} from "./api.js";
import { renderDiscordMessages } from "./render.js";

const log = getLogger("discord-send");

/**
 * Mention types Discord is allowed to resolve in an outbound message.
 *
 * The agent composes this text, and text it authored (or echoed from an
 * untrusted inbound message) must never be able to ping a whole server or a
 * whole role. `users` is kept so the assistant can address a person directly,
 * which is ordinary Discord conversation; `everyone` and `roles` are withheld.
 *
 * This mirrors the invite scope the setup skill requests, which deliberately
 * excludes Mention Everyone, and closes the role-mention gap that permission
 * alone leaves open.
 */
const DISCORD_ALLOWED_MENTIONS = { parse: ["users"] } as const;

/**
 * Upper bound on an outbound attachment. Discord's real limit is the guild's
 * boost tier (10 MiB with no boosts, more above that), which the API does not
 * expose here, so the client-side guard is only the ceiling no tier exceeds:
 * past it the upload is provably futile and not worth the bandwidth. Anything
 * under it is attempted and, if the guild's own tier rejects it, reported
 * through the same failure notice as any other attachment error.
 */
const DISCORD_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Send target for one Discord delivery. */
export interface DiscordSendTarget {
  /**
   * Snowflake of the channel the message is posted to. For a threaded reply
   * this is the thread's own id, because a Discord thread *is* a channel and
   * `POST /channels/{id}/messages` addresses it directly.
   */
  channelId: string;
}

function messagesRoute(target: DiscordSendTarget): string {
  return `/channels/${encodeURIComponent(target.channelId)}/messages`;
}

/** Outcome of a Discord reply send. */
export interface DiscordSendResult {
  /**
   * Channel-native id of the last chunk sent, for callers that need to address
   * the message later. Undefined when the API response carried no id.
   */
  lastMessageId?: string;
}

/**
 * Send a text reply, split across as many messages as Discord's content cap
 * requires. Chunks post in order so the reply reads top to bottom.
 */
export async function sendDiscordReply(
  target: DiscordSendTarget,
  text: string,
): Promise<DiscordSendResult> {
  const chunks = renderDiscordMessages(text);
  if (chunks.length === 0) {
    return {};
  }

  let lastMessageId: string | undefined;
  for (const chunk of chunks) {
    const sent = await callDiscordApi<DiscordMessage>(
      "POST",
      messagesRoute(target),
      {
        content: chunk,
        allowed_mentions: DISCORD_ALLOWED_MENTIONS,
      },
    );
    lastMessageId = typeof sent?.id === "string" ? sent.id : undefined;
  }

  log.debug(
    { channelId: target.channelId, chunks: chunks.length },
    "Discord reply sent",
  );
  return lastMessageId !== undefined ? { lastMessageId } : {};
}

export interface DiscordAttachmentResult {
  allFailed: boolean;
  failureCount: number;
  totalCount: number;
}

/**
 * Upload attachments to a Discord channel, one request per file so a single
 * rejection does not take the rest of the batch with it.
 *
 * Discord's documented upload shape is a `multipart/form-data` body whose
 * files ride as `files[n]` parts, with the JSON body moved to `payload_json`
 * and each file declared in an `attachments` array keyed by the same `n`.
 */
export async function sendDiscordAttachments(
  target: DiscordSendTarget,
  attachments: RuntimeAttachmentMetadata[],
): Promise<DiscordAttachmentResult> {
  const failures: string[] = [];

  /**
   * Name a failed file for the channel notice. A refusal Discord explains
   * (over the guild's upload limit, missing Attach Files) is worth passing on,
   * since the reader can act on it; anything else stays bare, because the
   * detail is a transport error the reader cannot do anything about.
   */
  const describeFailure = (name: string, err: unknown): string =>
    err instanceof DiscordNonRetryableError
      ? `${name} (Discord returned ${err.status})`
      : name;

  for (const meta of attachments) {
    const displayName = meta.filename ?? meta.id;

    if (
      meta.sizeBytes !== undefined &&
      meta.sizeBytes > DISCORD_MAX_ATTACHMENT_BYTES
    ) {
      log.warn(
        { attachmentId: meta.id, sizeBytes: meta.sizeBytes },
        "Skipping oversized outbound attachment",
      );
      failures.push(displayName);
      continue;
    }

    try {
      const content = getAttachmentContent(meta.id);
      if (!content) {
        log.error(
          { attachmentId: meta.id },
          "Attachment content not found in store",
        );
        failures.push(displayName);
        continue;
      }

      if (content.length > DISCORD_MAX_ATTACHMENT_BYTES) {
        log.warn(
          { attachmentId: meta.id, sizeBytes: content.length },
          "Skipping oversized outbound attachment (detected after read)",
        );
        failures.push(displayName);
        continue;
      }

      const blob = new Blob([new Uint8Array(content)], {
        type: meta.mimeType ?? "application/octet-stream",
      });
      const form = new FormData();
      form.set(
        "payload_json",
        JSON.stringify({
          attachments: [{ id: 0, filename: displayName }],
          allowed_mentions: DISCORD_ALLOWED_MENTIONS,
        }),
      );
      form.set("files[0]", blob, displayName);

      await callDiscordApiMultipart(messagesRoute(target), form);

      log.debug(
        { channelId: target.channelId, attachmentId: meta.id },
        "Attachment sent to Discord",
      );
    } catch (err) {
      log.error(
        { err, attachmentId: meta.id, filename: displayName },
        "Failed to send attachment to Discord",
      );
      failures.push(describeFailure(displayName, err));
    }
  }

  if (failures.length > 0) {
    const notice = `⚠️ ${failures.length} attachment(s) could not be delivered: ${failures.join(", ")}`;
    try {
      await sendDiscordReply(target, notice);
    } catch (err) {
      log.error(
        { err, channelId: target.channelId },
        "Failed to send attachment failure notice",
      );
    }
  }

  return {
    allFailed: failures.length === attachments.length,
    failureCount: failures.length,
    totalCount: attachments.length,
  };
}

/**
 * Show the Discord typing indicator in a channel.
 *
 * Discord expires it after about ten seconds, so a caller that wants it to
 * persist re-sends on a timer rather than clearing it; there is no stop route.
 */
export async function sendDiscordTypingIndicator(
  target: DiscordSendTarget,
): Promise<void> {
  await callDiscordApi(
    "POST",
    `/channels/${encodeURIComponent(target.channelId)}/typing`,
    {},
  );
}
