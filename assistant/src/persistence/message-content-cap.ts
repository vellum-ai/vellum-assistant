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
  | "recovery"
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
  const blocks = resolveMessageContentBlocks(content);
  let trimmed = trimBlocksToCap(blocks);
  if (trimmed === undefined && dropRichToolResultBlocks(blocks) > 0) {
    // The oversized bytes sat in media a tool result carried alongside its
    // text, which is optional: dropping it keeps the result itself sliceable.
    trimmed = trimBlocksToCap(blocks);
  }
  const capped =
    trimmed?.content ?? JSON.stringify(collapsedBlocks(blocks, originalBytes));
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

/**
 * Strip the rich `contentBlocks` a tool result carries alongside its text.
 * Those blocks hold media whose bytes cannot be sliced, and the field is
 * optional, so dropping it shrinks the row without invalidating the result.
 * Returns how many blocks were stripped.
 */
function dropRichToolResultBlocks(blocks: ContentBlock[]): number {
  let dropped = 0;
  for (const block of blocks) {
    // guard:allow-tool-result-only: `contentBlocks` is a client tool_result
    // field, and a server-side search result carries no such sibling media.
    if (block.type === "tool_result" && block.contentBlocks !== undefined) {
      delete block.contentBlocks;
      dropped++;
    }
  }
  return dropped;
}

/**
 * Stand-in content for a row with nothing safe to slice.
 *
 * Tool identity survives the collapse: a result keeps its `tool_use_id` and a
 * use keeps its id and name, on both the client (`tool_use` / `tool_result`)
 * and server (`server_tool_use` / `web_search_tool_result`) pairings, because
 * a message that loses one half of a pairing is rejected by the providers on
 * every later turn, which is the failure this cap exists to prevent.
 * Everything else becomes a single marker naming the original size.
 */
function collapsedBlocks(
  blocks: ContentBlock[],
  originalBytes: number,
): ContentBlock[] {
  const marker = collapsedMarker(originalBytes);
  const toolBlocks: ContentBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "tool_result":
        toolBlocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: marker,
          ...(block.is_error === true ? { is_error: true } : {}),
        });
        break;
      case "web_search_tool_result":
        toolBlocks.push({
          type: "web_search_tool_result",
          tool_use_id: block.tool_use_id,
          content: marker,
        });
        break;
      case "tool_use":
      case "server_tool_use":
        toolBlocks.push({
          type: block.type,
          id: block.id,
          name: block.name,
          input: {},
        });
        break;
      default:
        break;
    }
  }
  if (toolBlocks.length === 0) {
    return [{ type: "text", text: marker }];
  }
  // A `tool_result` carries its own marker, and providers want the results at
  // the head of the message, so no sibling text block is added there. A
  // `tool_use` has no text field, so the marker precedes it.
  const head = toolBlocks[0];
  if (head.type === "tool_result" || head.type === "web_search_tool_result") {
    return toolBlocks;
  }
  return [{ type: "text", text: marker }, ...toolBlocks];
}

function collapsedMarker(originalBytes: number): string {
  return `[dropped at persistence: this message body was ${originalBytes} bytes, over the ${MAX_PERSISTED_MESSAGE_BYTES}-byte single-message cap, and held no text that could be trimmed to fit]`;
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
        // Rich blocks a tool result carries hold trimmable text of their own.
        if (block.contentBlocks) {
          fields.push(...collectTrimmableFields(block.contentBlocks));
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
