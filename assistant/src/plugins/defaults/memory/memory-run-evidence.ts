// ---------------------------------------------------------------------------
// Memory run evidence: what a background memory run durably produced.
// ---------------------------------------------------------------------------
//
// A background run's persisted message rows are the one record of what it
// did. A `tool_use` block proves only that the model asked; the durable write
// happens inside the executor, so a call counts as evidence only when a
// matching non-error `tool_result` is persisted on the same rows. The
// readers here apply that rule uniformly so every memory job that gates a
// state transition on "the run verifiably wrote something" (the
// retrospective's cursor advance, consolidation's buffer consumption)
// reads the same evidence the same way.
//
// This module sits at the plugin root (shared infra, not a tier) and imports
// nothing from the plugin, so `substrate/` and the spine can both reach it
// without a tier importing spine.

import type { ContentBlock } from "@vellumai/plugin-api";

/**
 * Whether the LAST persisted assistant row on the run's tail carries a text
 * block with non-whitespace content. Paired with a model-driven stop and
 * zero memory-write attempts, that closing reply is the persisted artifact
 * of a pass that read its window and had nothing to save: the model spoke
 * and then chose to end the run. Reading only the final row separates it
 * from a run whose narration went live but whose actual conclusion was
 * empty, as well as from a response that committed nothing at all
 * (thinking-only output, an empty content array).
 */
export function hasCommittedTextReply(messages: MessageLike[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") {
      continue;
    }
    const blocks = parseMessageBlocks(msg);
    if (blocks === null) {
      return false;
    }
    return blocks.some(
      (b) =>
        b.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
    );
  }
  return false;
}

/**
 * Whether the run's FINAL persisted row is an assistant reply in its own
 * words: text with non-whitespace content and no `tool_use` block. This is
 * the shape of a run the model ended itself, since the loop stops when the
 * assistant answers without asking for a tool. It is stricter than
 * {@link hasCommittedTextReply} on purpose: narration on a row that also
 * calls a tool ("fixing that page now" followed by `file_write`) is not a
 * conclusion, and a run whose last row is a tool result stopped mid-loop.
 */
export function endsWithTextReply(messages: MessageLike[]): boolean {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "assistant") {
    return false;
  }
  const blocks = parseMessageBlocks(last);
  if (blocks === null || blocks.some((b) => b.type === "tool_use")) {
    return false;
  }
  return blocks.some(
    (b) =>
      b.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
  );
}

/**
 * Ids of `tool_result` blocks on the run's user rows whose execution did not
 * report an error. Robust to malformed content JSON the same way
 * `extractRememberContents` is.
 */
export function collectSuccessfulToolResultIds(
  messages: MessageLike[],
): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "user") {
      continue;
    }
    for (const b of parseMessageBlocks(msg) ?? []) {
      // guard:allow-tool-result-only: success evidence for locally-executed
      // durable memory tools; server-side web_search_tool_result never
      // corresponds to a durable write and carries no is_error flag.
      if (
        b.type === "tool_result" &&
        typeof b.tool_use_id === "string" &&
        b.is_error !== true
      ) {
        ids.add(b.tool_use_id);
      }
    }
  }
  return ids;
}

/**
 * Count persisted `tool_use` blocks whose `name` is in `durableTools` across
 * the run's assistant rows. With a `succeededIds` set, only calls whose id
 * has a matching successful `tool_result` count (verified executions); with
 * `null`, every attempt counts regardless of outcome.
 */
export function countDurableToolUses(
  messages: MessageLike[],
  durableTools: ReadonlySet<string>,
  succeededIds: ReadonlySet<string> | null,
): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    for (const b of parseMessageBlocks(msg) ?? []) {
      if (
        b.type === "tool_use" &&
        durableTools.has(String(b.name)) &&
        (succeededIds === null ||
          (typeof b.id === "string" && succeededIds.has(b.id)))
      ) {
        count += 1;
      }
    }
  }
  return count;
}

export interface MessageLike {
  role: string;
  content: string | ContentBlock[];
}

/**
 * Parse a message row's content into its block objects, or `null` when the
 * content is malformed (unparseable JSON, not an array). Non-object entries
 * are dropped. Every evidence reader in this module goes through this so
 * malformed rows degrade the same way everywhere: skipped, not propagated.
 */
function parseMessageBlocks(
  msg: MessageLike,
): Record<string, unknown>[] | null {
  let blocks: unknown = msg.content;
  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(blocks)) {
    return null;
  }
  return blocks.filter(
    (block): block is Record<string, unknown> =>
      typeof block === "object" && block !== null,
  );
}

/**
 * Scan an array of message rows for `tool_use` blocks where `name` is
 * `"remember"` and return the `input.content` strings in order. Robust to
 * malformed content JSON: unparseable rows are skipped, not propagated.
 */
export function extractRememberContents(
  messages: MessageLike[],
  succeededIds?: ReadonlySet<string>,
): string[] {
  const contents: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    for (const b of parseMessageBlocks(msg) ?? []) {
      if (b.type !== "tool_use") {
        continue;
      }
      if (b.name !== "remember") {
        continue;
      }
      // When a success set is provided, only executions that reported a
      // non-error tool_result contribute facts: a failed remember never
      // wrote the buffer, and logging its facts would suppress the retry's
      // re-save via <already_remembered>.
      if (
        succeededIds !== undefined &&
        (typeof b.id !== "string" || !succeededIds.has(b.id))
      ) {
        continue;
      }
      const input = b.input;
      if (!input || typeof input !== "object") {
        continue;
      }
      const content = (input as Record<string, unknown>).content;
      // `remember` accepts a single string or an array of facts (batch form);
      // flatten both so batched saves still feed the dedup baseline.
      const facts = Array.isArray(content) ? content : [content];
      for (const fact of facts) {
        if (typeof fact !== "string") {
          continue;
        }
        const trimmed = fact.trim();
        if (trimmed.length > 0) {
          contents.push(trimmed);
        }
      }
    }
  }
  return contents;
}
