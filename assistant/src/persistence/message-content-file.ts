/**
 * File-backed message content: the JSONL delta format and the ref resolver.
 *
 * A `messages.content` value is a union of two shapes:
 *   - Inline: a JSON-serialized `ContentBlock[]` (or a legacy plain string).
 *   - Ref:    `{ "ref": "conversations/<dir>/inflight/<uuid>.jsonl" }`
 *             pointing at a JSONL delta file that folds to a
 *             `ContentBlock[]`.
 *
 * The ref path is workspace-relative and MUST live under the reserved
 * `conversations/` prefix with a `.jsonl` extension — the schema rejects
 * anything else. This is the migration-safe discriminator against legacy
 * plain-string rows: a legacy message whose entire text happens to parse as
 * `{ "ref": … }` is only misread if it also names a reserved content path,
 * which no organic legacy text does.
 *
 * The delta file is append-only. Each line is `{ i, seq, block }` where `i`
 * is the block index in the final array and `seq` is a monotonically
 * increasing write sequence. Folding keeps the highest-`seq` line per `i`
 * and orders the surviving blocks by `i`, so a partially-flushed or
 * crash-truncated file still folds to the newest complete snapshot of each
 * block.
 *
 * {@link resolveMessageContentBlocks} is the single resolution seam:
 * consumers take the raw stored string off the message row and resolve it
 * to typed blocks here — a raw `{ ref }` value is never interpreted
 * anywhere else.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { z } from "zod";

import { contentBlockSchema } from "../providers/content-block-schema.js";
import type { ContentBlock } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("message-content-file");

/**
 * Ref-shaped `messages.content` value. The reserved-path constraint is the
 * discriminator that keeps legacy plain-string rows that parse as arbitrary
 * JSON objects from being mistaken for a ref.
 */
export const messageContentRefSchema = z.object({
  ref: z
    .string()
    .regex(
      /^conversations\/.+\.jsonl$/,
      "content refs must be workspace-relative paths under conversations/ ending in .jsonl",
    ),
});

export type MessageContentRef = z.infer<typeof messageContentRefSchema>;

/** One line of the append-only content delta file. */
const contentDeltaLineSchema = z.object({
  /** Index of `block` in the folded `ContentBlock[]`. */
  i: z.number(),
  /** Monotonic write sequence; the highest `seq` per `i` wins the fold. */
  seq: z.number(),
  block: contentBlockSchema,
});

export type ContentDeltaLine = z.infer<typeof contentDeltaLineSchema>;

/**
 * Parse a raw `messages.content` string to a ref, or null when the value is
 * inline content. The charCode fast path keeps the overwhelmingly common
 * inline-array case to a single character check.
 */
export function parseContentRef(raw: string): MessageContentRef | null {
  if (raw.charCodeAt(0) !== 0x7b /* '{' */) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = messageContentRefSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Resolve a workspace-relative content ref to an absolute path, rejecting
 * anything that escapes the workspace directory (e.g. a ref containing
 * `..` segments that still matched the reserved-prefix schema). Returns
 * null on escape.
 */
export function resolveContentRefPath(ref: string): string | null {
  const workspaceDir = resolve(getWorkspaceDir());
  const abs = resolve(workspaceDir, ref);
  if (abs !== workspaceDir && !abs.startsWith(workspaceDir + sep)) {
    return null;
  }
  return abs;
}

/**
 * Append delta lines to a content file, creating parent directories on
 * first write. Callers own write exclusivity — a message's delta file has
 * exactly one writer (the owning turn) for its lifetime.
 */
export function appendContentDeltas(
  absPath: string,
  deltas: ContentDeltaLine[],
): void {
  if (deltas.length === 0) {
    return;
  }
  mkdirSync(dirname(absPath), { recursive: true });
  appendFileSync(absPath, deltas.map((d) => JSON.stringify(d) + "\n").join(""));
}

/**
 * Fold raw JSONL delta text into a `ContentBlock[]`: highest `seq` per
 * block index wins, blocks ordered by index. Malformed lines (including a
 * crash-truncated final line) are skipped.
 */
export function foldContentDeltas(text: string): ContentBlock[] {
  const byIndex = new Map<number, { seq: number; block: ContentBlock }>();
  for (const line of text.split("\n")) {
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const result = contentDeltaLineSchema.safeParse(parsed);
    if (!result.success) {
      continue;
    }
    const { i, seq, block } = result.data;
    const existing = byIndex.get(i);
    if (!existing || seq > existing.seq) {
      byIndex.set(i, { seq, block });
    }
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => entry.block);
}

/**
 * Read and fold a content delta file. Returns null when the file is
 * missing or unreadable — callers decide the fallback.
 */
export function foldContentFile(absPath: string): ContentBlock[] | null {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  return foldContentDeltas(text);
}

/** Fold a validated ref to blocks; empty content on missing/escaping refs. */
function resolveRefToBlocks(ref: MessageContentRef): ContentBlock[] {
  const absPath = resolveContentRefPath(ref.ref);
  if (!absPath) {
    log.warn(
      { ref: ref.ref },
      "Content ref escapes the workspace directory; resolving as empty",
    );
    return [];
  }
  const blocks = foldContentFile(absPath);
  if (blocks === null) {
    // Normal for a row born in-flight that has not partial-flushed yet
    // (fast replies inside the debounce window) — the file only exists
    // once the first flush appends to it.
    log.debug(
      { ref: ref.ref },
      "Content ref file missing or unreadable; resolving as empty",
    );
    return [];
  }
  return blocks;
}

/** Serialize an arbitrary value for embedding in a repaired text block. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Repair a historical block that fails the current schema. Field-level
 * repair for the variants whose string fields consumers touch directly
 * (text, tool_result, web_search_tool_result); any other block that at
 * least carries a string `type` passes through untouched — persisted
 * kinds outside the provider union (e.g. `ui_surface`) are live data
 * whose renderers own their shape. Only type-less values are wrapped in
 * a text block carrying their serialized payload.
 */
function coerceLegacyBlock(block: unknown): ContentBlock {
  if (typeof block === "object" && block !== null) {
    const rec = block as Record<string, unknown>;
    if (rec.type === "text") {
      return {
        type: "text",
        text: typeof rec.text === "string" ? rec.text : safeJson(rec.text),
      };
    }
    if (rec.type === "tool_result" || rec.type === "web_search_tool_result") {
      const toolUseId =
        typeof rec.tool_use_id === "string" ? rec.tool_use_id : "";
      if (rec.type === "web_search_tool_result") {
        // content is opaque (provider-specific) — only the id needs repair.
        return {
          type: "web_search_tool_result",
          tool_use_id: toolUseId,
          content: rec.content,
        };
      }
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content:
          typeof rec.content === "string" ? rec.content : safeJson(rec.content),
        ...(typeof rec.is_error === "boolean"
          ? { is_error: rec.is_error }
          : {}),
      };
    }
    if (typeof rec.type === "string") {
      return block as ContentBlock;
    }
  }
  return { type: "text", text: safeJson(block) };
}

/**
 * Resolve a stored `messages.content` value to a `ContentBlock[]`.
 *
 * This is the expressive form of the resolver:
 *   - Inline `ContentBlock[]` JSON parses to its blocks.
 *   - A `{ ref }` folds its delta file (empty on missing/escaping refs).
 *   - A JSON string unwraps to its parsed value as a single text block
 *     (parity with the legacy readers); any other legacy plain string or
 *     non-array JSON becomes a text block carrying the raw value.
 *
 * Every returned block is guaranteed to satisfy the ContentBlock schema —
 * historical rows with malformed or retired block shapes are repaired
 * per-block ({@link coerceLegacyBlock}) rather than passed through, so
 * consumers can use variant fields without runtime shape guards.
 *
 * Never throws — content reads must not take down read paths.
 */
export function resolveMessageContentBlocks(raw: unknown): ContentBlock[] {
  if (typeof raw !== "string") {
    log.warn(
      { rawType: typeof raw },
      "Non-string stored message content; resolving as empty",
    );
    return [];
  }
  const ref = parseContentRef(raw);
  if (ref) {
    return resolveRefToBlocks(ref);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // legacy plain string
    return [{ type: "text", text: raw }];
  }
  if (typeof parsed === "string") {
    return [{ type: "text", text: parsed }];
  }
  if (Array.isArray(parsed)) {
    const result = z.array(contentBlockSchema).safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    // Historical rows may carry malformed or retired block shapes. Repair
    // per block — valid blocks stay untouched — so the returned array
    // always satisfies the schema. Only the rare invalid row pays this.
    log.warn(
      { issueCount: result.error.issues.length },
      "Inline content array has invalid block shapes; repairing per block",
    );
    return parsed.map((block) => {
      const one = contentBlockSchema.safeParse(block);
      return one.success ? one.data : coerceLegacyBlock(block);
    });
  }
  return [{ type: "text", text: raw }];
}
