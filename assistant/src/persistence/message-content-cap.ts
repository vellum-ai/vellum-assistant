/**
 * Provider-safe ceiling on the size of a single persisted message, applied at
 * every `messages.content` write seam.
 *
 * Providers cap an individual string in the request body: OpenAI rejects a
 * request whose input carries a string over 10485760 bytes with
 * `string_above_max_length`. A conversation resends its whole history on every
 * turn, so one oversized row does not fail a single turn, it bricks the
 * conversation for good: every later turn replays the same row and gets the
 * same 400. In-flight bounds (the `post-tool-use` truncation hook, the
 * result-time spool pass) shrink what the model sees, and a row that reaches
 * the DB uncompacted anyway has no second line of defence, which is what this
 * module is.
 *
 * The cap COMPACTS rather than rejects. Refusing the write would orphan a
 * `tool_use` whose paired `tool_result` never landed, which providers reject
 * on every subsequent turn, so a dropped row trades one unsendable
 * conversation for another. Compaction keeps the block structure and trims
 * only the oversized string payloads, so the row stays sendable and readable.
 *
 * Only text-ish payloads are trimmed: `text`, string `tool_result` content,
 * `thinking`, and a file block's `extracted_text`. Base64 media and other
 * structural fields are never sliced, because a truncated base64 source is a
 * corrupt attachment rather than a smaller one. A message that clears the cap
 * on those bytes alone leaves nothing safe to slice, so it collapses to a
 * single marker block: the row and the conversation survive, which a value the
 * provider refuses on every future turn does not.
 *
 * @see {@link https://platform.openai.com/docs/api-reference/responses/create}
 */

import { StringDecoder } from "node:string_decoder";

import type { ContentBlock } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { resolveMessageContentBlocks } from "./message-content-file.js";

const log = getLogger("message-content-cap");

/**
 * Maximum UTF-8 byte size of a single `messages.content` value. Set well
 * under OpenAI's 10485760-byte per-string limit so that a row at the cap
 * still leaves room for the wrapping the provider adapters add.
 */
export const MAX_PERSISTED_MESSAGE_BYTES = 8_000_000;

/** Largest number of UTF-8 bytes one UTF-16 code unit can encode to. */
const MAX_BYTES_PER_CODE_UNIT = 3;

/** Allowance refinements attempted before collapsing the content. */
const MAX_TRIM_PASSES = 4;

/** Where a capped write came from, for the warn log. */
export type MessageContentCapSource =
  | "insert"
  | "update"
  | "finalize"
  | "prune";

export interface MessageContentCapContext {
  source: MessageContentCapSource;
  conversationId?: string;
  messageId?: string;
}

/** UTF-8 byte size of a stored content value. */
export function messageContentBytes(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/**
 * Whether a content value exceeds {@link MAX_PERSISTED_MESSAGE_BYTES}. The
 * code-unit fast path answers the overwhelmingly common small message without
 * encoding it, since a string encodes to at most
 * {@link MAX_BYTES_PER_CODE_UNIT} bytes per code unit.
 */
export function exceedsPersistedMessageCap(content: string): boolean {
  if (content.length <= MAX_PERSISTED_MESSAGE_BYTES / MAX_BYTES_PER_CODE_UNIT) {
    return false;
  }
  return messageContentBytes(content) > MAX_PERSISTED_MESSAGE_BYTES;
}

/**
 * Bound `content` to {@link MAX_PERSISTED_MESSAGE_BYTES}, trimming the
 * oversized string payloads of its blocks and returning serialized content
 * the providers accept. Content already under the cap is returned untouched.
 *
 * A value that is not an inline block array (a legacy plain-string row) is
 * normalized to a single-`text`-block array on the way through, because a
 * partial slice of raw stored JSON is not parseable content.
 */
export function capPersistedMessageContent(
  content: string,
  ctx: MessageContentCapContext,
): string {
  if (!exceedsPersistedMessageCap(content)) {
    return content;
  }
  const originalBytes = messageContentBytes(content);
  const trimmed = trimBlocksToCap(resolveMessageContentBlocks(content));
  const capped =
    trimmed?.content ?? JSON.stringify([collapsedBlock(originalBytes)]);
  log.warn(
    {
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      bytes: originalBytes,
      cappedBytes: messageContentBytes(capped),
      trimmedFields: trimmed?.fields ?? 0,
      collapsed: trimmed === undefined,
      source: ctx.source,
    },
    trimmed
      ? "Message content exceeded the persisted size cap; trimmed its oversized blocks"
      : "Message content exceeded the persisted size cap with nothing safe to slice; collapsed it to a marker block",
  );
  return capped;
}

/**
 * Trim the string payloads of `blocks` until the serialized array fits the
 * cap, or give up when no allowance leaves room for them.
 *
 * The allowance is derived from the serialized size rather than the raw field
 * sizes: JSON escaping expands a payload by up to 6 bytes per character, so a
 * budget computed from raw bytes can still serialize over the cap. Each pass
 * scales the allowance by how far the last one landed from the cap, which
 * converges in one step for content with a uniform escaping cost and in a
 * handful for the rest. Trimming re-reads each field's original text, so a
 * later pass supersedes an earlier one instead of compounding it.
 */
function trimBlocksToCap(
  blocks: ContentBlock[],
): { content: string; fields: number } | undefined {
  const fields = collectTrimmableFields(blocks);
  const trimmableBytes = fields.reduce((sum, f) => sum + f.bytes, 0);
  const structuralBytes =
    messageContentBytes(JSON.stringify(blocks)) - trimmableBytes;
  let allowance = MAX_PERSISTED_MESSAGE_BYTES - structuralBytes;
  for (let pass = 0; pass < MAX_TRIM_PASSES && allowance > 0; pass++) {
    const trimmedFields = trimFields(fields, allowance);
    const content = JSON.stringify(blocks);
    const bytes = messageContentBytes(content);
    if (bytes <= MAX_PERSISTED_MESSAGE_BYTES) {
      return { content, fields: trimmedFields };
    }
    allowance = Math.floor(
      (allowance * (MAX_PERSISTED_MESSAGE_BYTES - structuralBytes)) /
        (bytes - structuralBytes),
    );
  }
  return undefined;
}

function collapsedBlock(originalBytes: number): ContentBlock {
  return {
    type: "text",
    text: `[dropped at persistence: this message body was ${originalBytes} bytes, over the ${MAX_PERSISTED_MESSAGE_BYTES}-byte single-message cap, and held no text that could be trimmed to fit]`,
  };
}

/** A block field holding a trimmable string payload. */
interface TrimmableField {
  bytes: number;
  text: string;
  write(next: string): void;
}

function collectTrimmableFields(blocks: ContentBlock[]): TrimmableField[] {
  const fields: TrimmableField[] = [];
  const push = (text: string, write: (next: string) => void): void => {
    if (text.length === 0) {
      return;
    }
    fields.push({ text, bytes: messageContentBytes(text), write });
  };
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        push(block.text, (next) => {
          block.text = next;
        });
        break;
      case "thinking":
        push(block.thinking, (next) => {
          block.thinking = next;
        });
        break;
      case "tool_result":
        if (typeof block.content === "string") {
          push(block.content, (next) => {
            block.content = next;
          });
        }
        break;
      case "file":
        if (typeof block.extracted_text === "string") {
          push(block.extracted_text, (next) => {
            block.extracted_text = next;
          });
        }
        break;
      default:
        break;
    }
  }
  return fields;
}

/**
 * Share `budget` bytes across `fields` and trim the ones that do not fit,
 * returning how many were trimmed. Fields are visited smallest first so the
 * headroom left by every field under its share rolls into the shares of the
 * larger ones: with one 50 MB block among small ones, only the 50 MB block is
 * cut, and it keeps everything the budget allows.
 */
function trimFields(fields: TrimmableField[], budget: number): number {
  let remaining = budget;
  let unassigned = fields.length;
  let trimmed = 0;
  for (const field of [...fields].sort((a, b) => a.bytes - b.bytes)) {
    const share = Math.floor(remaining / unassigned);
    unassigned--;
    if (field.bytes <= share) {
      remaining -= field.bytes;
      continue;
    }
    const marker = trimMarker(field.bytes);
    const markerBytes = messageContentBytes(marker);
    const keep = Math.max(0, share - markerBytes);
    const next = sliceToBytes(field.text, keep) + marker;
    field.write(next);
    remaining -= messageContentBytes(next);
    trimmed++;
  }
  return trimmed;
}

function trimMarker(originalBytes: number): string {
  return `\n\n[truncated at persistence: this block was ${originalBytes} bytes, over the ${MAX_PERSISTED_MESSAGE_BYTES}-byte single-message cap]`;
}

/**
 * Slice `text` to at most `maxBytes` UTF-8 bytes. The decoder holds back an
 * incomplete trailing sequence instead of emitting a replacement character,
 * so the result never ends mid-code-point.
 */
function sliceToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return text;
  }
  return new StringDecoder("utf8").write(buf.subarray(0, maxBytes));
}
