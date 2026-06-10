/**
 * Conversation lifecycle helpers extracted from Conversation: abort and
 * dispose. Each operates on a context interface so the Conversation class
 * can delegate without exposing its full surface.
 */

import { getConfig } from "../config/loader.js";
import type { EventBus } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";
import type { ToolProfiler } from "../events/tool-profiling-listener.js";
import { enqueueAutoAnalysisIfEnabled } from "../memory/auto-analysis-enqueue.js";
import { isAutoAnalysisConversation } from "../memory/auto-analysis-guard.js";
import { enqueueMemoryJob, isMemoryEnabled } from "../memory/jobs-store.js";
import { enqueueMemoryRetrospectiveIfEnabled } from "../memory/memory-retrospective-enqueue.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import { disposeContextWindowManager } from "../plugins/defaults/compaction/manager-store.js";
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
import { resetSkillToolProjection } from "./conversation-skill-tools.js";
import type { SurfaceData, SurfaceType } from "./message-protocol.js";

const log = getLogger("conversation-lifecycle");

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

export interface AbortContext {
  readonly conversationId: string;
  isProcessing(): boolean;
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

// ── abort ─────────────────────────────────────────────────────────────

export function abortConversation(
  ctx: AbortContext,
  reason?: AbortReason,
): void {
  if (ctx.isProcessing()) {
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
      if (!v2Enabled && isMemoryEnabled()) {
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
  // The compaction module owns the per-conversation ContextWindowManager, so
  // teardown releases it directly. Moving this behind a compaction-plugin hook
  // would let the module own disposal end-to-end, but the per-turn `stop` hook
  // would first require relocating the manager's only
  // cross-turn state — `nonPersistedPrefixCount` — off the manager so a
  // per-turn dispose/rebuild stays correct.
  disposeContextWindowManager(ctx.conversationId);
}
