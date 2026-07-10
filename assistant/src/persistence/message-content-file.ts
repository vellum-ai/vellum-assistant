/**
 * File-backed message content: the JSONL delta format and the ref resolver.
 *
 * A `messages.content` value is a union of two shapes:
 *   - Inline: a JSON-serialized `ContentBlock[]` (or a legacy plain string).
 *   - Ref:    `{ "ref": "<workspace-relative path>" }` pointing at a JSONL
 *             delta file that folds to a `ContentBlock[]`.
 *
 * The delta file is append-only. Each line is `{ i, seq, block }` where `i`
 * is the block index in the final array and `seq` is a monotonically
 * increasing write sequence. Folding keeps the highest-`seq` line per `i`
 * and orders the surviving blocks by `i`, so a partially-flushed or
 * crash-truncated file still folds to the newest complete snapshot of each
 * block.
 *
 * All content reads must go through {@link resolveStoredMessageContent}
 * (wired into the message row mapper) — downstream consumers never see a
 * raw `{ ref }` value.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import type { ContentBlock } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("message-content-file");

/** Ref-shaped `messages.content` value pointing at a delta file. */
export interface MessageContentRef {
  /** Path of the JSONL delta file, relative to the workspace directory. */
  ref: string;
}

/** One line of the append-only content delta file. */
export interface ContentDeltaLine {
  /** Index of `block` in the folded `ContentBlock[]`. */
  i: number;
  /** Monotonic write sequence; the highest `seq` per `i` wins the fold. */
  seq: number;
  block: ContentBlock;
}

/**
 * Narrow a parsed `messages.content` value to the ref shape. Strict on
 * purpose (exactly one key) so a legacy plain-string message that happens
 * to parse as an object can never be mistaken for a ref.
 */
export function isMessageContentRef(
  value: unknown,
): value is MessageContentRef {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { ref?: unknown }).ref === "string" &&
    (value as { ref: string }).ref.length > 0
  );
}

/**
 * Resolve a workspace-relative content ref to an absolute path, rejecting
 * anything that escapes the workspace directory. Returns null on escape.
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
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const { i, seq, block } = parsed as Partial<ContentDeltaLine>;
    if (
      typeof i !== "number" ||
      typeof seq !== "number" ||
      typeof block !== "object" ||
      block === null
    ) {
      continue;
    }
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

/**
 * Resolve a stored `messages.content` value to its inline JSON form.
 *
 * Inline values (JSON `ContentBlock[]` or legacy plain strings) pass
 * through untouched — the common case costs one character check. Ref
 * values are resolved by folding the delta file and returning the folded
 * blocks as a JSON string, so every consumer downstream of the row mapper
 * sees the same shape it always has.
 *
 * Never throws. A missing/unreadable file or an escaping ref resolves to
 * `"[]"` (empty content) with a warning — content reads must not take
 * down read paths.
 */
export function resolveStoredMessageContent(raw: string): string {
  // Inline arrays start with '[', legacy plain strings rarely start with
  // '{' — and when one does, the parse/shape checks below reject it.
  if (typeof raw !== "string" || raw.charCodeAt(0) !== 0x7b /* '{' */) {
    return raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isMessageContentRef(parsed)) {
    return raw;
  }
  const absPath = resolveContentRefPath(parsed.ref);
  if (!absPath) {
    log.warn(
      { ref: parsed.ref },
      "Content ref escapes the workspace directory; resolving as empty",
    );
    return "[]";
  }
  const blocks = foldContentFile(absPath);
  if (blocks === null) {
    log.warn(
      { ref: parsed.ref },
      "Content ref file missing or unreadable; resolving as empty",
    );
    return "[]";
  }
  return JSON.stringify(blocks);
}
