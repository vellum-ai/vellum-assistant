import { buildArchiveRecall } from "../memory/archive-recall.js";
import { compileMemoryBrief } from "../memory/brief.js";
import { getDb } from "../memory/db.js";
import { injectMemoryRecallAsUserBlock } from "../memory/inject.js";
import type { MemoryRecallResult as SearchRecallResult } from "../memory/search/types.js";
import type { Message } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";

const log = getLogger("conversation-memory");

export interface MemoryRecallResult {
  runMessages: Message[];
  recall: SearchRecallResult;
}

export interface MemoryPrepareContext {
  conversationId: string;
  messages: Message[];
  systemPrompt: string;
  provider: { name: string };
  scopeId: string;
  includeDefaultFallback: boolean;
  trustClass: "guardian" | "trusted_contact" | "unknown";
}

/**
 * Returns true when the latest user turn is an internal tool-result-only
 * message (no user-authored text/image content).
 */
function isToolResultOnlyUserTurn(message: Message | undefined): boolean {
  return (
    message?.role === "user" &&
    message.content.length > 0 &&
    message.content.every(
      (block) =>
        block.type === "tool_result" || block.type === "web_search_tool_result",
    )
  );
}

/**
 * Fast gate that determines whether the current turn warrants memory
 * retrieval. Returns `false` for mechanical no-ops (empty content,
 * tool-result-only) so the full memory pipeline can be skipped.
 * Runs in microseconds — no external calls.
 *
 * Note: We intentionally avoid character-length heuristics here.
 * Short messages like "What did I say?" or "My preferences?" are
 * legitimate memory queries. Per AGENTS.md, judgement calls about
 * message value should be routed through the daemon, not hardcoded.
 */
export function needsMemory(messages: Message[], content: string): boolean {
  // Empty or whitespace-only content — mechanical validation, nothing to query
  if (!content || content.trim().length === 0) return false;

  // Tool-result-only turns (assistant tool loop)
  const latestMessage = messages[messages.length - 1];
  if (isToolResultOnlyUserTurn(latestMessage)) return false;

  return true;
}

/**
 * Build memory context for a single agent loop turn. Compiles the
 * `<memory_brief>` block and conditionally appends `<supporting_recall>`
 * from the archive. Returns the augmented run messages and metadata for
 * downstream event emission.
 *
 * Memory context is injected as a text content block prepended to the
 * last user message (same pattern as workspace/temporal injections).
 * Stripping is handled by `RUNTIME_INJECTION_PREFIXES` which includes
 * `<memory_brief>`.
 */
export async function prepareMemoryContext(
  ctx: MemoryPrepareContext,
  content: string,
  userMessageId: string,
  _abortSignal: AbortSignal,
  onEvent: (msg: ServerMessage) => void,
): Promise<MemoryRecallResult> {
  // Provenance-based trust gating: untrusted actors skip all memory operations
  // to prevent untrusted content from influencing memory-augmented responses.
  const isTrustedActor = ctx.trustClass === "guardian";

  // Build a no-op result that skips the entire memory pipeline.
  const noopResult = (): MemoryRecallResult => ({
    runMessages: ctx.messages,
    recall: {
      enabled: false,
      degraded: false,
      injectedText: "",
      semanticHits: 0,
      recencyHits: 0,
      mergedCount: 0,
      selectedCount: 0,
      injectedTokens: 0,
      latencyMs: 0,
      topCandidates: [],
      tier1Count: 0,
      tier2Count: 0,
    },
  });

  if (!isTrustedActor) {
    return noopResult();
  }

  // Gate: skip the entire memory pipeline for mechanical no-ops (empty
  // content, tool-result-only turns).
  if (!needsMemory(ctx.messages, content)) {
    return noopResult();
  }

  const start = Date.now();

  const emptyRecall = (): SearchRecallResult => ({
    enabled: true,
    degraded: false,
    injectedText: "",
    semanticHits: 0,
    recencyHits: 0,
    mergedCount: 0,
    selectedCount: 0,
    injectedTokens: 0,
    latencyMs: 0,
    topCandidates: [],
    tier1Count: 0,
    tier2Count: 0,
  });

  try {
    const db = getDb();

    // Step 1: Build the memory brief
    const briefResult = compileMemoryBrief(db, ctx.scopeId, userMessageId);

    // Step 2: Conditionally build supporting recall from the archive
    const archiveResult = buildArchiveRecall(ctx.scopeId, content);

    // Step 3: Assemble the injection blocks (non-empty only)
    const blocks: string[] = [];
    if (briefResult.text.length > 0) {
      blocks.push(briefResult.text);
    }
    if (archiveResult.text.length > 0) {
      blocks.push(archiveResult.text);
    }

    const latencyMs = Date.now() - start;

    // Emit memory status
    onEvent({
      type: "memory_status",
      enabled: true,
      degraded: false,
    });

    // Inject non-empty blocks into the last user message
    let runMessages = ctx.messages;
    if (blocks.length > 0) {
      const injectedText = blocks.join("\n\n");
      const userTail = ctx.messages[ctx.messages.length - 1];
      if (userTail && userTail.role === "user") {
        runMessages = injectMemoryRecallAsUserBlock(ctx.messages, injectedText);
      }

      log.debug(
        {
          briefLength: briefResult.text.length,
          recallTrigger: archiveResult.trigger,
          recallBullets: archiveResult.bullets.length,
          latencyMs,
        },
        "Memory injection completed",
      );
    }

    return {
      runMessages,
      recall: {
        ...emptyRecall(),
        injectedText: blocks.length > 0 ? blocks.join("\n\n") : "",
        latencyMs,
      },
    };
  } catch (err) {
    log.warn({ err }, "Memory injection failed, returning no-op");
    return {
      runMessages: ctx.messages,
      recall: {
        ...emptyRecall(),
        latencyMs: Date.now() - start,
      },
    };
  }
}
