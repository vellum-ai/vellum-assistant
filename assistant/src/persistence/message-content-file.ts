/**
 * File-backed message content: the JSONL delta format and the ref resolver.
 *
 * A `messages.content` value is a union of two shapes:
 *   - Inline: a JSON-serialized `ContentBlock[]` (or a legacy plain string).
 *   - Ref:    `{ "ref": "conversations/<dir>/…/<messageId>.jsonl" }` pointing
 *             at a JSONL delta file that folds to a `ContentBlock[]`.
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
 * All content reads must go through {@link resolveMessageContentBlocks}
 * (expressive form) or {@link resolveStoredMessageContent} (the string shim
 * wired into the message row mapper) — downstream consumers never see a raw
 * `{ ref }` value.
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
 * Ref-shaped `messages.content` value. Strict (no extra keys) and
 * reserved-path constrained so legacy plain-string rows that parse as
 * arbitrary JSON objects can never be mistaken for a ref.
 */
export const messageContentRefSchema = z
  .object({
    ref: z
      .string()
      .regex(
        /^conversations\/.+\.jsonl$/,
        "content refs must be workspace-relative paths under conversations/ ending in .jsonl",
      ),
  })
  .strict();

export type MessageContentRef = z.infer<typeof messageContentRefSchema>;

/** One line of the append-only content delta file. */
const contentDeltaLineSchema = z
  .object({
    /** Index of `block` in the folded `ContentBlock[]`. */
    i: z.number(),
    /** Monotonic write sequence; the highest `seq` per `i` wins the fold. */
    seq: z.number(),
    block: contentBlockSchema,
  })
  .strict();

export type ContentDeltaLine = z.infer<typeof contentDeltaLineSchema>;

/**
 * Parse a raw `messages.content` string to a ref, or null when the value is
 * inline content. The charCode fast path keeps the overwhelmingly common
 * inline-array case to a single character check.
 */
function parseContentRef(raw: string): MessageContentRef | null {
  if (typeof raw !== "string" || raw.charCodeAt(0) !== 0x7b /* '{' */) {
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
    log.warn(
      { ref: ref.ref },
      "Content ref file missing or unreadable; resolving as empty",
    );
    return [];
  }
  return blocks;
}

/**
 * Resolve a stored `messages.content` value to a `ContentBlock[]`.
 *
 * This is the expressive form of the resolver:
 *   - Inline `ContentBlock[]` JSON parses to its blocks.
 *   - A `{ ref }` folds its delta file (empty on missing/escaping refs).
 *   - A legacy plain string (or any non-array, non-ref JSON) becomes a
 *     single text block carrying the raw value.
 *
 * Never throws — content reads must not take down read paths.
 */
export function resolveMessageContentBlocks(raw: string): ContentBlock[] {
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
  if (Array.isArray(parsed)) {
    const result = z.array(contentBlockSchema).safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    // Historical rows may carry block variants that predate the current
    // union (the renderer tolerates unknown types in its default case).
    // Pass them through rather than mangling stored content into a text
    // wrap; this is the one legacy boundary the schema cannot close.
    log.warn(
      { issueCount: result.error.issues.length },
      "Inline content array has unrecognized block shapes; passing through unvalidated",
    );
    return parsed as ContentBlock[];
  }
  return [{ type: "text", text: raw }];
}

/**
 * Resolve a stored `messages.content` value to its inline JSON string form.
 *
 * String shim over the resolver for call sites whose contract is the raw
 * stored string — today that is `MessageRow.content` via the row mapper.
 * Inline values (JSON `ContentBlock[]` or legacy plain strings) pass
 * through by identity — the common case costs one character check — so
 * legacy-string handling stays byte-identical for existing consumers.
 * Prefer {@link resolveMessageContentBlocks} in new code.
 */
export function resolveStoredMessageContent(raw: string): string {
  const ref = parseContentRef(raw);
  if (!ref) {
    return raw;
  }
  return JSON.stringify(resolveRefToBlocks(ref));
}
