/**
 * The reference a reader stages when they pick "Reference in Vellum" on a
 * message in the channel drawer, and how it reaches the assistant.
 *
 * ## Why the reference ships as text
 *
 * The reference has to survive the trip to the assistant as *data*: which
 * channel, which message, which thread, who sent it, when, where to find it,
 * and what it said. There is no seam on the wire to carry that. `POST
 * /v1/messages` accepts `content`, `attachmentIds`, and a fixed set of scalar
 * turn-context fields (`clientTimezone`, `visibleAppId`, `clientOs`, …) and
 * nothing free-form; see the `messages_post` `requestBody` in
 * `assistant/src/runtime/routes/conversation-routes.ts`. Persisted rows have
 * no metadata bag either: `ConversationMessage` carries typed projections
 * only.
 *
 * So the reference is encoded into the outgoing message body, the same seam
 * the composer uses for staged quotes and path references (see
 * `buildContentWithQuotes` / `appendPathReferences` in `use-composer-submit`).
 * The block is deterministic and delimited so the assistant can read the
 * fields rather than infer them from prose, and it renders as an ordinary
 * blockquote on the sent row, which is the only rendering message metadata
 * permits.
 */

import type { ChannelMessageProvenance } from "@/domains/chat/channel-sidecar/channel-message-provenance";
import {
  channelTimestampToIso,
  type ChannelSidecarTarget,
  type ChannelTranscriptEntry,
} from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";

/**
 * One staged external-channel message, pinned to the Vellum composer.
 *
 * Field names are the neutral vocabulary, not any channel's: a Slack
 * `channelTs` and an email `Message-ID` both land in `externalMessageId`.
 */
export interface ChannelReference {
  /** Transcript row the reference was taken from; also the dedupe identity. */
  messageId: string;
  conversationId: string;
  channelId: string;
  /** Human channel name for the chip, resolved by the caller. */
  channelLabel: string;
  threadName?: string;
  externalMessageId?: string;
  externalThreadId?: string;
  externalChatId?: string;
  senderName?: string;
  /** Epoch ms, when the row carries one. */
  timestamp?: number;
  sourceHref?: string;
  /** Body text, bounded to {@link CHANNEL_REFERENCE_SNIPPET_MAX}. */
  snippet: string;
  /** Whether {@link snippet} was cut. */
  isTruncated: boolean;
}

/**
 * Longest snippet a reference carries into the outgoing message. Bounded so a
 * referenced wall of text cannot dominate what the user sends; the drawer
 * itself renders the row in full, so the cut applies only here.
 */
export const CHANNEL_REFERENCE_SNIPPET_MAX = 400;

function boundedSnippet(value: string): {
  snippet: string;
  isTruncated: boolean;
} {
  const collapsed = value.trim();
  if (collapsed.length <= CHANNEL_REFERENCE_SNIPPET_MAX) {
    return { snippet: collapsed, isTruncated: false };
  }
  return {
    snippet: `${collapsed.slice(0, CHANNEL_REFERENCE_SNIPPET_MAX).trimEnd()}…`,
    isTruncated: true,
  };
}

/** Build a reference from a drawer row plus the thread it belongs to. */
export function toChannelReference({
  entry,
  target,
  channelLabel,
}: {
  entry: ChannelTranscriptEntry;
  target: ChannelSidecarTarget;
  channelLabel: string;
}): ChannelReference {
  const provenance: ChannelMessageProvenance = entry.provenance;
  const { snippet, isTruncated } = boundedSnippet(entry.text);
  const reference: ChannelReference = {
    messageId: entry.id,
    conversationId: target.conversationId,
    channelId: provenance.channelId,
    channelLabel,
    snippet,
    isTruncated,
  };
  if (target.threadName) {
    reference.threadName = target.threadName;
  }
  if (provenance.externalMessageId) {
    reference.externalMessageId = provenance.externalMessageId;
  }
  if (provenance.externalThreadId) {
    reference.externalThreadId = provenance.externalThreadId;
  }
  if (provenance.externalChatId) {
    reference.externalChatId = provenance.externalChatId;
  }
  if (provenance.senderName) {
    reference.senderName = provenance.senderName;
  }
  if (entry.timestamp != null) {
    reference.timestamp = entry.timestamp;
  }
  const href = provenance.sourceLink?.webUrl ?? provenance.sourceLink?.appUrl;
  if (href ?? target.sourceHref) {
    reference.sourceHref = href ?? target.sourceHref;
  }
  return reference;
}

/**
 * Sentinel opening the encoded block. Stable and machine-shaped on purpose:
 * it is a protocol token the assistant matches on, so it is not translated and
 * not reworded for tone. The same reasoning applies to the field names below.
 */
const REFERENCE_OPEN = "[vellum:channel-reference]";
const REFERENCE_CLOSE = "[/vellum:channel-reference]";

/**
 * Render a reference as the delimited block that ships inside the outgoing
 * message.
 *
 * Every line is quoted so the whole block renders as one blockquote in the
 * sent bubble, which is how staged quotes already read, and the sentinels
 * survive that rendering because they are literal text rather than markup.
 * Absent fields are omitted rather than emitted empty: a reader (human or
 * model) should not have to tell "unknown" apart from "blank".
 */
export function formatChannelReference(reference: ChannelReference): string {
  const fields: Array<[string, string | undefined]> = [
    ["channel", reference.channelId],
    ["conversation", reference.externalChatId],
    ["conversation-name", reference.threadName],
    ["thread", reference.externalThreadId],
    ["message-id", reference.externalMessageId],
    ["sender", reference.senderName],
    ["sent-at", channelTimestampToIso(reference.timestamp)],
    ["source", reference.sourceHref],
    ["snippet-truncated", reference.isTruncated ? "true" : undefined],
  ];

  const lines: string[] = [REFERENCE_OPEN];
  for (const [key, value] of fields) {
    const trimmed = value?.trim();
    if (trimmed) {
      lines.push(`${key}: ${trimmed}`);
    }
  }
  lines.push("text:");
  for (const line of (reference.snippet || "(no text content)").split("\n")) {
    lines.push(`  ${line}`);
  }
  lines.push(REFERENCE_CLOSE);

  return lines.map((line) => `> ${line}`.trimEnd()).join("\n");
}

/**
 * Fold a staged reference into the message the user is about to send.
 *
 * The reference leads: it is the thing being talked about, and the freeform
 * text is the user's remark on it. Mirrors the quote ordering the composer
 * already uses.
 */
export function prependChannelReference(
  content: string,
  reference: ChannelReference | null,
): string {
  if (!reference) {
    return content;
  }
  const block = formatChannelReference(reference);
  return content ? `${block}\n\n${content}` : block;
}
