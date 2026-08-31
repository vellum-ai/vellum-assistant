/**
 * Discord outbound message orchestration.
 *
 * Splits replies into Discord-sized chunks (see ./render.ts) and uploads
 * attachments, by calling the Discord REST API directly via ./api.ts.
 */

import type { ApprovalUIMetadata } from "@vellumai/gateway-client";

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

// Component wire values, from Discord's message-components table.
const DISCORD_COMPONENT_ACTION_ROW = 1;
const DISCORD_COMPONENT_BUTTON = 2;
const DISCORD_BUTTON_STYLE_PRIMARY = 1;
const DISCORD_BUTTON_STYLE_SECONDARY = 2;
const DISCORD_BUTTON_STYLE_DANGER = 4;
/** Discord caps a component `custom_id` at 100 characters. */
const DISCORD_MAX_CUSTOM_ID_CHARS = 100;
/** Discord caps a button label at 80 characters. */
const DISCORD_MAX_BUTTON_LABEL_CHARS = 80;
/** Discord caps an action row at five buttons. */
const DISCORD_MAX_BUTTONS_PER_ROW = 5;

interface DiscordButtonComponent {
  type: typeof DISCORD_COMPONENT_BUTTON;
  style: number;
  label: string;
  custom_id: string;
}

interface DiscordActionRow {
  type: typeof DISCORD_COMPONENT_ACTION_ROW;
  components: DiscordButtonComponent[];
}

/** Translate a surface-agnostic emphasis into Discord's button style value. */
function discordStyleForEmphasis(
  emphasis: "primary" | "secondary" | "destructive",
): number {
  switch (emphasis) {
    case "primary":
      return DISCORD_BUTTON_STYLE_PRIMARY;
    case "destructive":
      return DISCORD_BUTTON_STYLE_DANGER;
    case "secondary":
      return DISCORD_BUTTON_STYLE_SECONDARY;
  }
}

/**
 * Build the action rows for an approval card. Each button's `custom_id` is
 * the shared `apr:<requestId>:<action>` callback convention, which the
 * gateway forwards verbatim as the button event's `callbackData`. Styling
 * mirrors the Slack card: an action's own `emphasis` wins, otherwise the
 * first action is primary and `reject` is danger. Discord requires a style
 * on every button, so the remainder are explicitly secondary.
 *
 * Throws when a `custom_id` would exceed Discord's cap: the caller falls
 * back to the plain-text card rather than sending a button that could not
 * round-trip its request id.
 */
function buildDiscordApprovalComponents(
  approval: ApprovalUIMetadata,
): DiscordActionRow[] {
  const buttons = approval.actions.map((action, index) => {
    const customId = `apr:${approval.requestId}:${action.id}`;
    if (customId.length > DISCORD_MAX_CUSTOM_ID_CHARS) {
      throw new Error(
        `custom_id for action "${action.id}" is ${customId.length} characters, exceeding Discord's ${DISCORD_MAX_CUSTOM_ID_CHARS}-character limit`,
      );
    }
    return {
      type: DISCORD_COMPONENT_BUTTON,
      style: action.emphasis
        ? discordStyleForEmphasis(action.emphasis)
        : action.id === "reject"
          ? DISCORD_BUTTON_STYLE_DANGER
          : index === 0
            ? DISCORD_BUTTON_STYLE_PRIMARY
            : DISCORD_BUTTON_STYLE_SECONDARY,
      label: action.label.slice(0, DISCORD_MAX_BUTTON_LABEL_CHARS),
      custom_id: customId,
    } satisfies DiscordButtonComponent;
  });
  const rows: DiscordActionRow[] = [];
  for (let i = 0; i < buttons.length; i += DISCORD_MAX_BUTTONS_PER_ROW) {
    rows.push({
      type: DISCORD_COMPONENT_ACTION_ROW,
      components: buttons.slice(i, i + DISCORD_MAX_BUTTONS_PER_ROW),
    });
  }
  return rows;
}

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

/**
 * A multi-chunk send that failed after at least one chunk was posted. The
 * already-delivered chunks cannot be unsent, so a caller with a fallback
 * must not replay the whole text; the undelivered remainder is what is
 * still owed to the reader.
 */
export class DiscordPartialSendError extends Error {
  readonly chunksSent: number;
  readonly remainingText: string;
  readonly lastMessageId?: string;

  constructor(
    cause: unknown,
    chunksSent: number,
    remainingText: string,
    lastMessageId?: string,
  ) {
    super(
      `Discord send failed after ${chunksSent} chunk(s): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "DiscordPartialSendError";
    this.chunksSent = chunksSent;
    this.remainingText = remainingText;
    if (lastMessageId !== undefined) {
      this.lastMessageId = lastMessageId;
    }
  }
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
 * Discord's rendering of a settled message.
 *
 * `-# ` is Discord's subtext markdown, which it describes as the same size and
 * colour as the dismiss line under a bot message. It is the closest thing
 * Discord has to Slack's context block, and it applies per line, so every line
 * carries the marker rather than only the first.
 *
 * @see https://support.discord.com/hc/en-us/articles/210298617
 */
function mutedText(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length === 0 ? line : `-# ${line}`))
    .join("\n");
}

/**
 * Replace a message the assistant already sent.
 *
 * Never posts. A failed edit throws so the original stands alone rather than
 * gaining a duplicate beside it, which is the whole reason editing is its own
 * capability.
 *
 * Deliberately does not chunk. An edit addresses one message, and a
 * replacement too long for one is a condition the caller has to know about
 * rather than one this can paper over by dropping the tail. Discord rejects an
 * over-length body and that rejection propagates.
 *
 * @see https://discord.com/developers/docs/resources/message#edit-message
 */
export async function editDiscordMessage(
  target: DiscordSendTarget,
  messageId: string,
  text: string,
  options?: { emphasis?: "muted" },
): Promise<void> {
  await callDiscordApi<DiscordMessage>(
    "PATCH",
    `${messagesRoute(target)}/${encodeURIComponent(messageId)}`,
    {
      content: options?.emphasis === "muted" ? mutedText(text) : text,
      allowed_mentions: DISCORD_ALLOWED_MENTIONS,
      // A PATCH that omits `components` keeps whatever the message carries,
      // and every edit through this path states a final text: a card that
      // has been answered or withdrawn must not keep live buttons. Always
      // stripping makes that an invariant rather than a caller's chore.
      components: [],
    },
  );
  log.debug(
    { channelId: target.channelId, messageId },
    "Discord message edited",
  );
}

/**
 * Send a text reply, split across as many messages as Discord's content cap
 * requires. Chunks post in order so the reply reads top to bottom.
 */
export async function sendDiscordReply(
  target: DiscordSendTarget,
  text: string,
  approval?: ApprovalUIMetadata,
): Promise<DiscordSendResult> {
  const chunks = renderDiscordMessages(text);
  if (chunks.length === 0) {
    return {};
  }

  // Buttons ride the final chunk: its id is the one recorded on the delivery
  // row, so the message a press arrives on is the message the row can find.
  const components = approval ? buildDiscordApprovalComponents(approval) : [];

  let lastMessageId: string | undefined;
  for (const [index, chunk] of chunks.entries()) {
    try {
      const sent = await callDiscordApi<DiscordMessage>(
        "POST",
        messagesRoute(target),
        {
          content: chunk,
          allowed_mentions: DISCORD_ALLOWED_MENTIONS,
          ...(components.length > 0 && index === chunks.length - 1
            ? { components }
            : {}),
        },
      );
      lastMessageId = typeof sent?.id === "string" ? sent.id : undefined;
    } catch (err) {
      // Nothing posted yet propagates plainly; a caller may retry or fall
      // back with the full text. Past the first chunk the delivered prefix
      // cannot be unsent, so the error names what is still owed.
      if (index === 0) {
        throw err;
      }
      throw new DiscordPartialSendError(
        err,
        index,
        chunks.slice(index).join("\n"),
        lastMessageId,
      );
    }
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
