/**
 * Conversation lifecycle methods extracted from Conversation: loadFromDb, abort,
 * and dispose. Each operates on a context interface so the Conversation class
 * can delegate without exposing its full surface.
 */

import { getConfig } from "../config/loader.js";
import { createContextSummaryMessage } from "../context/window-manager.js";
import type { EventBus } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";
import type { ToolProfiler } from "../events/tool-profiling-listener.js";
import { enqueueAutoAnalysisIfEnabled } from "../memory/auto-analysis-enqueue.js";
import { isAutoAnalysisConversation } from "../memory/auto-analysis-guard.js";
import {
  getConversation,
  getMessages,
  type MessageRow,
} from "../memory/conversation-crud.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import { enqueueMemoryRetrospectiveIfEnabled } from "../memory/memory-retrospective-enqueue.js";
import { shouldExposePersonalMemory } from "../memory/v2/static-context.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import type { ContentBlock, Message } from "../providers/types.js";
import {
  isUntrustedTrustClass,
  type TrustClass,
} from "../runtime/actor-trust-resolver.js";
import { unregisterConversationSender } from "../tools/browser/browser-screencast.js";
import { type AbortReason, createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import { unregisterCallNotifiers } from "./conversation-notifiers.js";
import type { MessageQueue } from "./conversation-queue-manager.js";
import { stripInjectionsForCompaction } from "./conversation-runtime-assembly.js";
import { resetSkillToolProjection } from "./conversation-skill-tools.js";
import { resolveTrustClass } from "./conversation-tool-setup.js";
import { repairHistory } from "./history-repair.js";
import type {
  SurfaceData,
  SurfaceType,
  UsageStats,
} from "./message-protocol.js";
import type { TrustContext } from "./trust-context.js";

const log = getLogger("conversation-lifecycle");

function parseProvenanceTrustClass(
  metadata: string | null,
): TrustClass | undefined {
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(metadata) as { provenanceTrustClass?: unknown };
    const trustClass = parsed?.provenanceTrustClass;
    if (
      trustClass === "guardian" ||
      trustClass === "trusted_contact" ||
      trustClass === "unknown"
    ) {
      return trustClass;
    }
  } catch {
    // Ignore malformed metadata and treat as unknown provenance.
  }
  return undefined;
}

export function filterMessagesForUntrustedActor(
  messages: MessageRow[],
): MessageRow[] {
  return messages.filter((m) => {
    const provenanceTrustClass = parseProvenanceTrustClass(m.metadata);
    return (
      provenanceTrustClass === "trusted_contact" ||
      provenanceTrustClass === "unknown"
    );
  });
}

/**
 * Re-inject image source path annotations into message content blocks.
 *
 * When the desktop client attaches images from local files, the source paths
 * are stored in `metadata.imageSourcePaths` (keyed by filename). The LLM-facing
 * content omits these paths at persistence time, so we re-inject them when
 * loading history from the DB. Only user messages are annotated.
 */
export function reinjectImageSourcePaths(
  content: ContentBlock[],
  role: string,
  metadataJson: string | null,
): ContentBlock[] {
  if (role !== "user" || !metadataJson) return content;
  try {
    const meta = JSON.parse(metadataJson);
    if (!meta.imageSourcePaths || typeof meta.imageSourcePaths !== "object") {
      return content;
    }
    const paths = Object.values(meta.imageSourcePaths).filter(
      (v): v is string => typeof v === "string",
    );
    if (paths.length === 0) return content;
    const annotation = paths
      .map((p) => `[Attached image source: ${p}]`)
      .join("\n");
    return [...content, { type: "text" as const, text: annotation }];
  } catch {
    // metadata parse failure — skip annotation, not critical
    return content;
  }
}

// ── Context Interfaces ───────────────────────────────────────────────

export interface LoadFromDbContext {
  readonly conversationId: string;
  messages: Message[];
  usageStats: UsageStats;
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
  trustContext?: TrustContext;
  loadedHistoryTrustClass?: TrustClass;
  loadedHistoryPersonalMemoryAllowed?: boolean;
}

export interface AbortContext {
  readonly conversationId: string;
  processing: boolean;
  abortController: AbortController | null;
  prompter: PermissionPrompter;
  secretPrompter: SecretPrompter;
  pendingSurfaceActions: Map<string, { surfaceType: SurfaceType }>;
  surfaceActionRequestIds: Set<string>;
  surfaceState: Map<
    string,
    {
      surfaceType: SurfaceType;
      data: SurfaceData;
      title?: string;
      actions?: Array<{
        id: string;
        label: string;
        style?: string;
        data?: Record<string, unknown>;
      }>;
    }
  >;
  accumulatedSurfaceState: Map<string, Record<string, unknown>>;
  readonly queue: MessageQueue;
}

export interface DisposeContext extends AbortContext {
  eventBus: EventBus<AssistantDomainEvents>;
  readonly skillProjectionState: Map<string, string>;
  profiler: ToolProfiler;
  messages: Message[];
  surfaceUndoStacks: Map<string, string[]>;
  currentTurnSurfaces: Array<unknown>;
  lastSurfaceAction: Map<string, unknown>;
  workspaceTopLevelContext: string | null;
  trustContext?: { trustClass: TrustClass };
  /** Active memory node IDs snapshotted from the conversation's InContextTracker before disposal. */
  activeContextNodeIds?: string[];
  abort(): void;
}

// ── loadFromDb ───────────────────────────────────────────────────────

export async function loadFromDb(ctx: LoadFromDbContext): Promise<void> {
  const trustClass = ctx.trustContext?.trustClass;
  const allDbMessages = getMessages(ctx.conversationId);
  const dbMessages = isUntrustedTrustClass(trustClass)
    ? filterMessagesForUntrustedActor(allDbMessages)
    : allDbMessages;

  const conv = getConversation(ctx.conversationId);
  const contextSummary = !isUntrustedTrustClass(trustClass)
    ? conv?.contextSummary?.trim() || null
    : null;
  if (isUntrustedTrustClass(trustClass)) {
    // Compacted summaries may include trusted/guardian-only details, so we
    // disable summary-based context for untrusted actor views.
    ctx.contextCompactedMessageCount = 0;
    ctx.contextCompactedAt = null;
  } else {
    ctx.contextCompactedMessageCount = Math.max(
      0,
      Math.min(conv?.contextCompactedMessageCount ?? 0, dbMessages.length),
    );
    ctx.contextCompactedAt = conv?.contextCompactedAt ?? null;
  }

  // `/clean` persists a timestamp; messages older than this should skip
  // metadata rehydration and have any injection prefixes still embedded in
  // their content stripped, so the cleaned state survives reload and forks.
  const cleanedAt = conv?.cleanedAt ?? null;
  const slicedDbMessages = dbMessages.slice(ctx.contextCompactedMessageCount);
  let preCleanCount = 0;
  if (cleanedAt != null) {
    const boundary = slicedDbMessages.findIndex(
      (m) => m.createdAt >= cleanedAt,
    );
    preCleanCount = boundary === -1 ? slicedDbMessages.length : boundary;
  }

  // Mirror the injection-time gate (`shouldExposePersonalMemory` in
  // `conversation-agent-loop.ts`) so background/local conversations
  // (sourceChannel `undefined` or `"vellum"`) can rehydrate the persisted
  // v2 static memory block. Use `resolveTrustClass` for parity with the
  // agent loop — it folds in the HTTP-auth-disabled dev bypass so
  // rehydration and injection agree on the effective trust class.
  const personalMemoryAllowed = shouldExposePersonalMemory({
    sourceChannel: ctx.trustContext?.sourceChannel,
    isTrustedActor: resolveTrustClass(ctx.trustContext) === "guardian",
  });
  const parsedMessages: Message[] = slicedDbMessages.map((m, index, arr) => {
    const isPreClean = index < preCleanCount;
    const role = m.role as "user" | "assistant";
    let content: ContentBlock[];
    try {
      const parsed = JSON.parse(m.content);
      content = Array.isArray(parsed)
        ? parsed
        : [{ type: "text", text: m.content }];
    } catch {
      log.warn(
        { conversationId: ctx.conversationId, messageId: m.id },
        "Invalid JSON in persisted message content, replacing with safe text block",
      );
      content = [{ type: "text", text: m.content }];
    }

    content = reinjectImageSourcePaths(content, role, m.metadata);

    // Re-inject persisted injection blocks from metadata so it survives
    // conversation reloads (eviction, restart, fork).
    if (role === "user" && m.metadata && !isPreClean) {
      try {
        const meta = JSON.parse(m.metadata);
        const isTail = index === arr.length - 1;

        // Rehydrate in reverse injection order (innermost block first)
        // so the resulting layout matches `applyRuntimeInjections`'s
        // after-memory-prefix splices in ascending injector order
        // (pkb-context 30, pkb-reminder 35, memory-v2-static 38,
        // now-md 40 — the v2 static block lands inside the memory
        // prefix, so now-md splices *after* it):
        //   [<workspace>, <turn_context>, <memory __injected>,
        //    <memory>\n…</memory>, <NOW.md>, <system_reminder>,
        //    <knowledge_base>, ...original]
        // Required so Anthropic's prefix cache keeps matching msg[0]
        // across daemon restart and conversation eviction. The tail
        // row only rehydrates `memoryInjectedBlock` — the next turn
        // re-injects the rest fresh.
        if (!isTail && typeof meta.pkbContextBlock === "string") {
          content = [
            { type: "text" as const, text: meta.pkbContextBlock },
            ...content,
          ];
        }

        if (!isTail && typeof meta.pkbSystemReminderBlock === "string") {
          content = [
            { type: "text" as const, text: meta.pkbSystemReminderBlock },
            ...content,
          ];
        }

        if (!isTail && typeof meta.nowScratchpadBlock === "string") {
          content = [
            { type: "text" as const, text: meta.nowScratchpadBlock },
            ...content,
          ];
        }

        // The v2 static memory block (essentials/threads/recent/buffer
        // wrapped in `<memory>…</memory>`) carries personal user memory.
        // Trust-gated to mirror `shouldExposePersonalMemory` at injection
        // time — untrusted-actor views must not read persisted personal
        // memory back through metadata. Skipped on the tail row because
        // the next turn re-injects fresh content on full-mode turns.
        if (
          !isTail &&
          personalMemoryAllowed &&
          typeof meta.memoryV2StaticBlock === "string"
        ) {
          content = [
            { type: "text" as const, text: meta.memoryV2StaticBlock },
            ...content,
          ];
        }

        // Memory remains rehydrated on all rows (existing behavior).
        // Strip any pre-existing wrapper before re-wrapping so historical
        // rows persisted with the wrapper (v2 path before the
        // injectedBlockText contract was unified with v1's unwrapped form)
        // don't render double-wrapped after rehydrate. Only unwrap when
        // the full <memory>...</memory> pair is present so we don't mutate
        // legitimate unwrapped payloads that happen to start with
        // "<memory>\n" or end with "\n</memory>".
        if (typeof meta.memoryInjectedBlock === "string") {
          const block = meta.memoryInjectedBlock;
          const inner =
            block.startsWith("<memory>\n") && block.endsWith("\n</memory>")
              ? block.slice("<memory>\n".length, -"\n</memory>".length)
              : block;
          content = [
            {
              type: "text" as const,
              text: `<memory>\n${inner}\n</memory>`,
            },
            ...content,
          ];
        }

        if (!isTail && typeof meta.turnContextBlock === "string") {
          content = [
            { type: "text" as const, text: meta.turnContextBlock },
            ...content,
          ];
        }

        if (!isTail && typeof meta.workspaceBlock === "string") {
          content = [
            { type: "text" as const, text: meta.workspaceBlock },
            ...content,
          ];
        }
      } catch {
        /* ignore parse errors — metadata may be malformed */
      }
    }

    return { role, content };
  });

  // Strip pre-clean messages only; post-clean messages keep the fresh
  // injections they were generated with.
  const messagesBeforeRepair =
    preCleanCount === 0
      ? parsedMessages
      : [
          ...stripInjectionsForCompaction(
            parsedMessages.slice(0, preCleanCount),
          ),
          ...parsedMessages.slice(preCleanCount),
        ];

  const { messages: repairedMessages, stats } =
    repairHistory(messagesBeforeRepair);
  if (
    stats.assistantToolResultsMigrated > 0 ||
    stats.missingToolResultsInserted > 0 ||
    stats.orphanToolResultsDowngraded > 0 ||
    stats.consecutiveSameRoleMerged > 0
  ) {
    log.warn(
      { conversationId: ctx.conversationId, phase: "load", ...stats },
      "Repaired persisted history",
    );
  }
  ctx.messages = repairedMessages;

  if (contextSummary) {
    ctx.messages.unshift(createContextSummaryMessage(contextSummary));
  }

  if (conv) {
    ctx.usageStats = {
      inputTokens: conv.totalInputTokens,
      outputTokens: conv.totalOutputTokens,
      estimatedCost: conv.totalEstimatedCost,
    };
  }

  ctx.loadedHistoryTrustClass = trustClass;
  ctx.loadedHistoryPersonalMemoryAllowed = personalMemoryAllowed;

  log.info(
    { conversationId: ctx.conversationId, count: ctx.messages.length },
    "Loaded messages from DB",
  );
}

// ── abort ─────────────────────────────────────────────────────────────

export function abortConversation(
  ctx: AbortContext,
  reason?: AbortReason,
): void {
  if (ctx.processing) {
    const effectiveReason =
      reason ??
      createAbortReason(
        "preempted_by_new_message",
        "abortConversation:default",
        ctx.conversationId,
      );
    log.info(
      { conversationId: ctx.conversationId, abortReason: effectiveReason },
      "Aborting in-flight processing",
    );
    ctx.abortController?.abort(effectiveReason);
    ctx.prompter.dispose();
    ctx.secretPrompter.dispose();
    ctx.pendingSurfaceActions.clear();
    ctx.surfaceActionRequestIds.clear();
    ctx.surfaceState.clear();
    ctx.accumulatedSurfaceState.clear();
    for (const queued of ctx.queue) {
      queued.onEvent({
        type: "generation_cancelled",
        conversationId: ctx.conversationId,
      });
    }
    ctx.queue.clear();
  }
}

// ── dispose ──────────────────────────────────────────────────────────

export function disposeConversation(ctx: DisposeContext): void {
  // Trigger graph extraction for end-of-conversation sweep.
  // Only extract from guardian conversations to preserve the memory trust
  // boundary — untrusted content must not influence future memory retrieval.
  if (!isUntrustedTrustClass(ctx.trustContext?.trustClass)) {
    // Recursion guard: skip graph_extract for auto-analysis conversations.
    // The analysis agent writes memory directly via tools, so extracting
    // from its reflective musings would double-write into the memory graph.
    // Mirrors the same guard applied in `indexer.ts` for the per-message
    // indexing path.
    // Fail open: if the guard lookup throws (e.g. DB unavailable during
    // teardown), default to NOT skipping so the rest of disposal still runs.
    let isAutoAnalysis = false;
    try {
      isAutoAnalysis = isAutoAnalysisConversation(ctx.conversationId);
    } catch {
      // Best-effort — don't block conversation disposal
    }
    if (!isAutoAnalysis) {
      // Suppress v1 graph extraction when memory v2 is active — v2 reads
      // from buffer.md and concept pages, so the v1 graph would be stale
      // data nobody consumes. Mirrors the gate applied in `indexer.ts`
      // for the per-message indexing path. Fail open to v1 if config
      // can't load, since the worker handler also short-circuits.
      let v2Enabled = false;
      try {
        v2Enabled = getConfig().memory.v2.enabled;
      } catch {
        // Best-effort — fall through to legacy v1 enqueue
      }
      if (!v2Enabled) {
        try {
          enqueueMemoryJob("graph_extract", {
            conversationId: ctx.conversationId,
            scopeId: "default",
            ...(ctx.activeContextNodeIds?.length
              ? { activeContextNodeIds: ctx.activeContextNodeIds }
              : {}),
          });
        } catch {
          // Best-effort — don't block conversation disposal
        }
      }

      try {
        // Memory-retrospective lifecycle safety-net. The periodic triggers
        // (interval / message_count / pre-compaction) handle the common
        // path; lifecycle catches the gap between the last interval fire
        // and conversation eviction. The job's `no_new_messages` early
        // return makes this a cheap no-op when the periodic path already
        // covered things. Lives inside the `!isAutoAnalysis` guard so
        // auto-analysis conversations don't trigger retrospective enqueues
        // on disposal — mirrors the indexer-time gate in `indexer.ts`.
        enqueueMemoryRetrospectiveIfEnabled({
          conversationId: ctx.conversationId,
          trigger: "lifecycle",
        });
      } catch {
        // Best-effort — don't block conversation disposal
      }
    }

    try {
      // `enqueueAutoAnalysisIfEnabled` has its own internal recursion guard
      // (it checks `isAutoAnalysisConversation()`), so it's safe to call
      // unconditionally here.
      enqueueAutoAnalysisIfEnabled({
        conversationId: ctx.conversationId,
        trigger: "lifecycle",
      });
    } catch {
      // Best-effort — don't block conversation disposal
    }
  }

  abortConversation(
    ctx,
    createAbortReason(
      "conversation_disposed",
      "disposeConversation",
      ctx.conversationId,
    ),
  );
  unregisterCallNotifiers(ctx.conversationId);
  unregisterConversationSender(ctx.conversationId);
  resetSkillToolProjection(ctx.skillProjectionState);
  ctx.eventBus.dispose();

  // Release heavy in-memory data so GC can reclaim it
  ctx.messages = [];
  ctx.profiler.clear();
  ctx.surfaceUndoStacks.clear();
  ctx.currentTurnSurfaces = [];
  ctx.pendingSurfaceActions.clear();
  ctx.surfaceActionRequestIds.clear();
  ctx.surfaceState.clear();
  ctx.accumulatedSurfaceState.clear();
  ctx.lastSurfaceAction.clear();
  ctx.workspaceTopLevelContext = null;
}
