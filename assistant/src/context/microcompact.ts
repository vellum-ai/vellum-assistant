import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "../providers/types.js";
import { estimateTextTokens } from "./token-estimator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of recent user-assistant exchanges to keep untouched. */
const DEFAULT_PROTECT_RECENT_TURNS = 4;

/** Default minimum reclaimable tokens required before we commit a pass. */
const DEFAULT_MIN_GAIN_TOKENS = 2_000;

/**
 * Default list of tool names whose results are never wholesale-cleared.
 * Matches opencode's `PRUNE_PROTECTED_TOOLS` and Claude Code's equivalent —
 * protects subagent outputs and curated skill results, which are expensive
 * to regenerate and usually load-bearing for the rest of the conversation.
 *
 * Note: ax-tree stripping still applies to protected tool results. Only the
 * full-body replacement is skipped.
 */
const DEFAULT_PROTECTED_TOOLS: readonly string[] = [
  "Task",
  "subagent",
  "skill",
];

/** Replacement body for cleared tool-result content. */
const CLEARED_TOOL_RESULT_TEXT = "[Old tool result content cleared]";

/** Replacement text for stubbed image blocks. */
const CLEARED_IMAGE_TEXT = "[image omitted]";

/** Replacement text for stubbed file blocks. */
const CLEARED_FILE_TEXT = "[file omitted]";

/**
 * Regex that matches `<ax-tree>...</ax-tree>` blocks (non-greedy).
 * Kept in sync with `AX_TREE_PATTERN` in `assistant/src/agent/loop.ts`; this
 * module subsumes that function's responsibility for stale tool results.
 */
const AX_TREE_PATTERN = /<ax-tree>[\s\S]*?<\/ax-tree>/g;

/** Placeholder inserted in place of a stripped ax-tree block. */
const AX_TREE_PLACEHOLDER = "<ax_tree_omitted />";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MicrocompactOptions {
  /** Preserve the last N user-assistant exchanges verbatim. Default 4. */
  protectRecentTurns?: number;
  /** Tool names whose results are never microcompacted (e.g. "Task", sub-agents). */
  protectedTools?: string[];
  /** Minimum reclaimable tokens required to bother — skip no-op passes. Default 2000. */
  minGainTokens?: number;
}

export interface MicrocompactResult {
  messages: Message[];
  reclaimedTokens: number;
  clearedToolResults: number;
  clearedImages: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministically compact stale content in the message history.
 *
 * Walks `messages` from newest to oldest. The most recent
 * `protectRecentTurns` user-assistant exchanges are left untouched. In the
 * older region:
 *
 *  - Each `tool_result` whose owning tool is NOT in `protectedTools` has its
 *    `content` replaced with a short placeholder.
 *  - Every `image` / `file` block is replaced with a text stub.
 *  - `<ax-tree>...</ax-tree>` blocks inside any tool_result (including
 *    protected ones) are collapsed to a placeholder, subsuming the old
 *    `compactAxTreeHistory` in `assistant/src/agent/loop.ts`.
 *
 * The `tool_use` / `tool_result` block structure is preserved — we only
 * mutate block bodies, never the block types or their pairing — so provider
 * serialization remains valid after compaction.
 *
 * If the estimated savings (`reclaimedTokens`) is below `minGainTokens`, the
 * original `messages` reference is returned unchanged. The pass is
 * idempotent: re-invoking on a previously compacted history produces zero
 * incremental reclaim.
 */
export function microcompact(
  messages: Message[],
  options?: MicrocompactOptions,
): MicrocompactResult {
  const protectRecentTurns =
    options?.protectRecentTurns ?? DEFAULT_PROTECT_RECENT_TURNS;
  const minGainTokens = options?.minGainTokens ?? DEFAULT_MIN_GAIN_TOKENS;
  const protectedToolSet = new Set(
    options?.protectedTools ?? DEFAULT_PROTECTED_TOOLS,
  );

  if (messages.length === 0) {
    return {
      messages,
      reclaimedTokens: 0,
      clearedToolResults: 0,
      clearedImages: 0,
    };
  }

  // Build a lookup of tool_use_id -> tool name by scanning every assistant
  // message. Tool_use_ids are globally unique within a conversation so a
  // single map is valid for the whole history.
  const toolNameById = buildToolNameLookup(messages);

  // Determine the index up to which messages are "protected" (left alone).
  // Anything at index >= firstProtectedIdx is in the protected tail; the
  // older region (indices < firstProtectedIdx) is where we clear.
  const firstProtectedIdx = computeProtectedBoundary(
    messages,
    protectRecentTurns,
  );

  if (firstProtectedIdx <= 0) {
    // Every message is protected — nothing to clear.
    return {
      messages,
      reclaimedTokens: 0,
      clearedToolResults: 0,
      clearedImages: 0,
    };
  }

  let reclaimedTokens = 0;
  let clearedToolResults = 0;
  let clearedImages = 0;
  let anyChange = false;

  const nextMessages: Message[] = messages.map((msg, idx) => {
    if (idx >= firstProtectedIdx) return msg;

    let changed = false;
    const nextContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type === "tool_result") {
        const tr = block as ToolResultContent;
        const toolName = toolNameById.get(tr.tool_use_id);
        const isProtected = toolName != null && protectedToolSet.has(toolName);

        const { replacement, tokensSaved, didChange, cleared } =
          compactToolResult(tr, isProtected);
        if (didChange) {
          reclaimedTokens += tokensSaved;
          if (cleared) clearedToolResults += 1;
          changed = true;
          return replacement;
        }
        return block;
      }

      if (block.type === "image") {
        const saved = estimateImageReclaim(block);
        // Only count a reclaim if stubbing actually shrinks the block.
        // The stub is always valid, but avoid double-counting no-op cases.
        reclaimedTokens += saved;
        clearedImages += 1;
        changed = true;
        return { type: "text", text: CLEARED_IMAGE_TEXT };
      }

      if (block.type === "file") {
        const saved = estimateFileReclaim(block);
        reclaimedTokens += saved;
        clearedImages += 1;
        changed = true;
        return { type: "text", text: CLEARED_FILE_TEXT };
      }

      return block;
    });

    if (!changed) return msg;
    anyChange = true;
    return { ...msg, content: nextContent };
  });

  if (!anyChange || reclaimedTokens < minGainTokens) {
    return {
      messages,
      reclaimedTokens: 0,
      clearedToolResults: 0,
      clearedImages: 0,
    };
  }

  return {
    messages: nextMessages,
    reclaimedTokens,
    clearedToolResults,
    clearedImages,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildToolNameLookup(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

/**
 * Return the index of the first message that is inside the "protected tail".
 *
 * A user-assistant exchange begins at a user message that carries real user
 * content (i.e. not a tool_result-only follow-up, which is how the provider
 * encodes the tool response turn). We walk newest-to-oldest and, once we've
 * seen `protectRecentTurns` such user-turn starts, return the index of the
 * oldest such start. Everything at or after that index is protected.
 *
 * If the history has fewer than `protectRecentTurns` user turns, protect the
 * entire history by returning 0.
 */
function computeProtectedBoundary(
  messages: Message[],
  protectRecentTurns: number,
): number {
  if (protectRecentTurns <= 0) return messages.length;

  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (isToolResultOnlyUserMessage(msg)) continue;
    seen += 1;
    if (seen >= protectRecentTurns) {
      return i;
    }
  }
  // Fewer user turns than the protection budget — protect everything.
  return 0;
}

/**
 * A user message that contains only tool_result blocks represents the
 * response side of a tool call rather than a fresh user turn.
 */
function isToolResultOnlyUserMessage(message: Message): boolean {
  if (message.content.length === 0) return false;
  return message.content.every((b) => b.type === "tool_result");
}

/**
 * Compact a single tool_result block in the stripped region.
 *
 *  - If `isProtected` is true, we keep the body but strip `<ax-tree>` blocks
 *    and drop any rich `contentBlocks` (images attached to the tool result).
 *  - Otherwise we replace the body with a short placeholder and drop
 *    `contentBlocks` entirely.
 *
 * `tokensSaved` is the delta between the original and the replacement as
 * measured by `estimateTextTokens`, floored at 0. `cleared` is true only when
 * we fully replaced the body (i.e. counted against `clearedToolResults`).
 */
function compactToolResult(
  block: ToolResultContent,
  isProtected: boolean,
): {
  replacement: ToolResultContent;
  tokensSaved: number;
  didChange: boolean;
  cleared: boolean;
} {
  const originalContent = block.content;
  const originalContentTokens = estimateTextTokens(originalContent);

  // Rich contentBlocks (e.g. tool-attached images) are always dropped in
  // the stripped region, regardless of protection. Protected tools retain
  // their text body; the images are not the expensive part of a subagent
  // result and are rarely load-bearing once the turn is stale.
  let contentBlocksTokens = 0;
  const hadContentBlocks =
    block.contentBlocks != null && block.contentBlocks.length > 0;
  if (hadContentBlocks) {
    for (const cb of block.contentBlocks!) {
      contentBlocksTokens += estimateContentBlockTokenCost(cb);
    }
  }

  let newContent: string;
  let cleared: boolean;
  if (isProtected) {
    // Strip ax-tree blocks but keep the rest of the text body.
    newContent = originalContent.replace(AX_TREE_PATTERN, AX_TREE_PLACEHOLDER);
    cleared = false;
  } else {
    newContent = CLEARED_TOOL_RESULT_TEXT;
    cleared = true;
  }

  const newContentTokens = estimateTextTokens(newContent);
  const bodyTokensSaved = originalContentTokens - newContentTokens;

  const bodyChanged = newContent !== originalContent;
  const didChange = bodyChanged || hadContentBlocks;

  if (!didChange) {
    return {
      replacement: block,
      tokensSaved: 0,
      didChange: false,
      cleared: false,
    };
  }

  const tokensSaved = Math.max(0, bodyTokensSaved + contentBlocksTokens);

  const replacement: ToolResultContent = {
    type: "tool_result",
    tool_use_id: block.tool_use_id,
    content: newContent,
  };
  if (block.is_error != null) {
    replacement.is_error = block.is_error;
  }

  return {
    replacement,
    tokensSaved,
    didChange,
    cleared: cleared && bodyChanged,
  };
}

function estimateImageReclaim(
  block: Extract<ContentBlock, { type: "image" }>,
): number {
  // Base64 payloads are the expensive part of image blocks for our naive
  // char/4 heuristic. The Anthropic-aware estimator in `token-estimator.ts`
  // charges per-pixel — we deliberately use the simpler heuristic here so
  // the reclaim number is a conservative lower bound on actual savings.
  const payloadTokens = estimateTextTokens(block.source.data);
  const stubTokens = estimateTextTokens(CLEARED_IMAGE_TEXT);
  return Math.max(0, payloadTokens - stubTokens);
}

function estimateFileReclaim(
  block: Extract<ContentBlock, { type: "file" }>,
): number {
  const payloadTokens =
    estimateTextTokens(block.source.data) +
    estimateTextTokens(block.extracted_text ?? "");
  const stubTokens = estimateTextTokens(CLEARED_FILE_TEXT);
  return Math.max(0, payloadTokens - stubTokens);
}

function estimateContentBlockTokenCost(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTextTokens(block.text);
    case "image":
      return estimateTextTokens(block.source.data);
    case "file":
      return (
        estimateTextTokens(block.source.data) +
        estimateTextTokens(block.extracted_text ?? "")
      );
    default:
      return 0;
  }
}
