/**
 * Message consolidation — shared logic that maps the raw DB row sequence
 * onto the displayed transcript.
 *
 * A single "display turn" in the UI can span multiple DB rows. During
 * streaming the agent loop persists each API call as a separate
 * assistant row (deferred consolidation, for prefix-cache stability),
 * and intervening user rows often carry only tool_result blocks that
 * are suppressed at display time. The two-pass collapse here is what
 * turns the raw sequence into the rows the user actually sees.
 *
 *   Pass 1 — `mergeToolResultsIntoAssistantMessages`
 *     For each user row, lift its `tool_result` (and `web_search_tool_result`)
 *     blocks onto the preceding assistant row. If the user row had
 *     nothing else (only tool_result + system_notice blocks), drop the
 *     row entirely. Otherwise keep its non-tool-result content as a
 *     real user message.
 *
 *   Pass 2 — `mergeConsecutiveAssistantMessages`
 *     After pass 1 removes tool-result-only user separators, fold runs
 *     of adjacent assistant rows onto the first row of the run
 *     ("anchor"). Anchors keep their id, createdAt, and metadata;
 *     subagent-notification metadata is promoted from later rows when
 *     the anchor lacks it.
 *
 * `findDisplayTurnEndIndex` is the primitive any write-path needs when
 * it has a single DB-row id and wants to know "which DB rows make up
 * the display turn that this row anchors". It uses the same
 * `isToolResultOnlyUserMessage` predicate that pass 1 uses to decide
 * which user rows are suppressed, so the read-path and write-path
 * agree on cluster boundaries without duplicating the merge code.
 */

import type { MessageRow } from "../persistence/conversation-crud.js";
import { isSystemCardMetadata } from "../persistence/conversation-crud.js";
import type { ContentBlock } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("message-consolidation");

/**
 * True when a row is a daemon-authored system card (`messageKind:
 * "system_card"` metadata). Cards are standalone display turns: they never
 * fold into an adjacent assistant run and adjacent assistant rows never
 * fold into them.
 */
export function isSystemCardRow(msg: MessageRow): boolean {
  if (msg.role !== "assistant" || !msg.metadata) {
    return false;
  }
  try {
    return isSystemCardMetadata(
      JSON.parse(msg.metadata) as Record<string, unknown>,
    );
  } catch {
    return false;
  }
}

// ── Block predicates ────────────────────────────────────────────────

function isToolResultType(type: string): boolean {
  return type === "tool_result" || type === "web_search_tool_result";
}

function isSystemNoticeText(block: ContentBlock): boolean {
  return (
    block.type === "text" &&
    block.text.startsWith("<system_notice>") &&
    block.text.endsWith("</system_notice>")
  );
}

/**
 * True when a user row's content is exclusively tool_result blocks
 * (and optional system_notice text). Such rows are suppressed by the
 * read-path collapse — they exist in the DB to satisfy the LLM's
 * tool_use ↔ tool_result pairing requirement but are never displayed
 * to the user. Any write-path that walks DB rows in display order
 * must treat them as part of the surrounding assistant turn.
 */
export function isToolResultOnlyUserMessage(msg: MessageRow): boolean {
  if (msg.role !== "user") {
    return false;
  }
  let sawToolResult = false;
  for (const block of msg.content) {
    if (isToolResultType(block.type)) {
      sawToolResult = true;
      continue;
    }
    if (isSystemNoticeText(block)) {
      continue;
    }
    return false;
  }
  return sawToolResult;
}

// ── Display-turn boundary lookup ────────────────────────────────────

/**
 * Returns the inclusive DB-row index where the display turn that
 * contains `messages[startIdx]` ends.
 *
 * For non-assistant rows, returns `startIdx` unchanged — only assistant
 * turns can span multiple rows.
 *
 * For assistant rows, advances past any consecutive rows that the
 * read-path collapse would fold into the same display turn:
 *   - another assistant row → part of the consecutive-assistant run, OR
 *   - a tool-result-only user row → suppressed at display time, sits
 *     between two halves of the same assistant turn.
 *
 * Stops at the first real user message (or any non-collapsible row),
 * end-of-array, or invalid index.
 *
 * Mirror of the cluster boundary that `mergeConsecutiveAssistantMessages`
 * (post pass-1) would produce — without paying the cost of parsing
 * every content block.
 */
export function findDisplayTurnEndIndex(
  messages: MessageRow[],
  startIdx: number,
): number {
  if (startIdx < 0 || startIdx >= messages.length) {
    return startIdx;
  }
  if (messages[startIdx]?.role !== "assistant") {
    return startIdx;
  }
  // A system card is a single-row display turn — never spans neighbours.
  if (isSystemCardRow(messages[startIdx]!)) {
    return startIdx;
  }

  let endIdx = startIdx;
  while (endIdx + 1 < messages.length) {
    const next = messages[endIdx + 1];
    if (!next) {
      break;
    }
    if (next.role === "assistant" && !isSystemCardRow(next)) {
      endIdx += 1;
      continue;
    }
    if (next.role === "user" && isToolResultOnlyUserMessage(next)) {
      endIdx += 1;
      continue;
    }
    break;
  }
  return endIdx;
}

// ── Pass 1: tool-result merging ─────────────────────────────────────

/**
 * Merge tool_result blocks from user messages into the preceding assistant
 * message's content array. This lets renderHistoryContent's pendingToolUses
 * map pair tool_use and tool_result blocks, preventing "unknown" tool names.
 *
 * User messages that consist entirely of tool_result blocks (and optional
 * system_notice text) are removed from the output. Mixed messages (tool_result
 * + real user text) keep only the non-tool-result blocks.
 */
export function mergeToolResultsIntoAssistantMessages(
  messages: MessageRow[],
): MessageRow[] {
  // Index of the most recent assistant message in the output array.
  let lastAssistantIdx = -1;
  // Parsed content caches — lazily populated per assistant message.
  const parsedAssistantContent = new Map<number, ContentBlock[]>();

  const result: MessageRow[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      lastAssistantIdx = result.length;
      result.push(msg);
      continue;
    }

    // Only process user messages — other roles pass through.
    if (msg.role !== "user") {
      result.push(msg);
      continue;
    }

    // Separate tool-result blocks from real user content.
    const toolResultBlocks: ContentBlock[] = [];
    const otherBlocks: ContentBlock[] = [];
    for (const block of msg.content) {
      if (isToolResultType(block.type)) {
        toolResultBlocks.push(block);
      } else {
        otherBlocks.push(block);
      }
    }

    // No tool results → pass through unchanged. System notices are only
    // injected alongside tool results in the agent loop, so a pure user
    // message (no tool_result blocks) should never be filtered — even if
    // the user's text happens to look like a system_notice tag.
    if (toolResultBlocks.length === 0) {
      result.push(msg);
      continue;
    }

    // Append tool_result blocks to the preceding assistant message's content.
    // No-op at pagination boundaries (lastAssistantIdx < 0); orphan tool_results
    // are silently dropped by renderHistoryContent downstream either way.
    if (lastAssistantIdx >= 0) {
      const assistant = result[lastAssistantIdx];
      let assistantContent = parsedAssistantContent.get(lastAssistantIdx);
      if (!assistantContent) {
        assistantContent = [...assistant.content];
        parsedAssistantContent.set(lastAssistantIdx, assistantContent);
      }
      assistantContent.push(...toolResultBlocks);
    }

    // If the user message had only tool_result (+ system_notice) blocks,
    // suppress it entirely. Otherwise keep the non-tool-result content.
    // System notices don't count as real user content — they are only
    // injected alongside tool results in the agent loop.
    const realUserContent = otherBlocks.filter((b) => !isSystemNoticeText(b));
    if (realUserContent.length > 0) {
      result.push({ ...msg, content: otherBlocks });
    }
    // else: tool-result-only → suppressed
  }

  // Write back any modified assistant message content.
  for (const [idx, content] of parsedAssistantContent) {
    result[idx] = { ...result[idx], content };
  }

  return result;
}

// ── Pass 2: consecutive-assistant merging ───────────────────────────

/**
 * Promote metadata fields from a donor message to the surviving message
 * when the survivor lacks them. Currently promotes `subagentNotification`.
 * Returns a new MessageRow if promotion occurred, otherwise the original.
 */
function promoteMetadata(survivor: MessageRow, donor: MessageRow): MessageRow {
  if (donor.metadata && survivor.metadata) {
    try {
      const survivorMeta = JSON.parse(survivor.metadata);
      const donorMeta = JSON.parse(donor.metadata);
      if (
        !survivorMeta.subagentNotification &&
        donorMeta.subagentNotification
      ) {
        survivorMeta.subagentNotification = donorMeta.subagentNotification;
        return { ...survivor, metadata: JSON.stringify(survivorMeta) };
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to parse metadata during assistant message merge",
      );
    }
  } else if (donor.metadata && !survivor.metadata) {
    return { ...survivor, metadata: donor.metadata };
  }
  return survivor;
}

/**
 * Merge consecutive assistant messages into a single message at query time.
 *
 * During streaming, all assistant turns within one agent loop accumulate on
 * a single client-side message. In the DB, each API turn is stored as a
 * separate assistant row (consolidation is deferred to compaction for
 * prefix-cache stability). This produces N separate assistant messages that
 * the client would otherwise render as N individual rows — each showing
 * "Completed 1 step" instead of one grouped "Completed N steps" accordion.
 *
 * This function concatenates the content block arrays of consecutive
 * assistant messages (no intervening user messages after tool-result
 * merging) into the first message of each run. The merged messages are
 * removed from the output. This is query-time only — the DB is not
 * modified.
 *
 * The first message in each run keeps its id, createdAt, and metadata so
 * that attachment lookups, display timestamps, and subagent notifications
 * continue to work. Metadata from later messages in the run (e.g.
 * subagentNotification) is preserved by promoting it to the surviving
 * message when the surviving message has no metadata of its own for that
 * field.
 */
export function mergeConsecutiveAssistantMessages(messages: MessageRow[]): {
  messages: MessageRow[];
  /** Maps each surviving message ID → all original message IDs merged into it. */
  mergedIdMap: Map<string, string[]>;
} {
  const result: MessageRow[] = [];
  // Key = index in `result`, value = accumulated content blocks.
  const pendingMerges = new Map<number, ContentBlock[]>();
  // Key = index in `result`, value = IDs of messages merged into the target.
  const mergedIds = new Map<number, string[]>();

  for (const msg of messages) {
    const lastIdx = result.length - 1;
    // System cards stay standalone in both directions: a card never folds
    // into the preceding assistant run, and the following assistant row
    // never folds into a card.
    const isConsecutiveAssistant =
      msg.role === "assistant" &&
      !isSystemCardRow(msg) &&
      lastIdx >= 0 &&
      result[lastIdx].role === "assistant" &&
      !isSystemCardRow(result[lastIdx]);

    if (!isConsecutiveAssistant) {
      result.push(msg);
      continue;
    }

    // Track the donor message ID.
    let ids = mergedIds.get(lastIdx);
    if (!ids) {
      ids = [];
      mergedIds.set(lastIdx, ids);
    }
    ids.push(msg.id);

    // Lazily parse the target's content on first merge.
    let targetContent = pendingMerges.get(lastIdx);
    if (!targetContent) {
      targetContent = [...result[lastIdx].content];
      pendingMerges.set(lastIdx, targetContent);
    }

    targetContent.push(...msg.content);
    result[lastIdx] = promoteMetadata(result[lastIdx], msg);
  }

  // Write back merged content for any messages that were targets.
  for (const [idx, content] of pendingMerges) {
    result[idx] = { ...result[idx], content };
  }

  // Build the merged ID map keyed by surviving message ID.
  const mergedIdMap = new Map<string, string[]>();
  for (const [idx, ids] of mergedIds) {
    mergedIdMap.set(result[idx].id, ids);
  }

  return { messages: result, mergedIdMap };
}
