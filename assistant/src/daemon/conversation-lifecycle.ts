/**
 * Conversation lifecycle helpers extracted from Conversation: abort and
 * dispose. Each operates on a context interface so the Conversation class
 * can delegate without exposing its full surface.
 */

import {
  formatImageSourceAnnotation,
  formatStoredPathAnnotation,
} from "../agent/attachments.js";
import { getConfig } from "../config/loader.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import {
  enqueueMemoryJob,
  isMemoryEnabled,
} from "../persistence/jobs-store.js";
import { disposeContextWindowManager } from "../plugins/defaults/compaction/manager-store.js";
import { enqueueMemoryRetrospectiveIfEnabled } from "../plugins/defaults/memory/memory-retrospective-enqueue.js";
import type { ContentBlock, Message } from "../providers/types.js";
import { type TrustClass } from "../runtime/actor-trust-resolver.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import { enqueueAutoAnalysisIfEnabled } from "../runtime/services/auto-analysis-enqueue.js";
import { isAutoAnalysisConversation } from "../runtime/services/auto-analysis-guard.js";
import { unregisterConversationSender } from "../tools/browser/browser-screencast.js";
import { disposeToolProfiler } from "../tools/tool-profiler.js";
import { type AbortReason, createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import { unregisterCallNotifiers } from "./conversation-notifiers.js";
import type { MessageQueue } from "./conversation-queue-manager.js";
import { resetSkillToolProjection } from "./conversation-skill-tools.js";
import type { SurfaceData, SurfaceType } from "./message-protocol.js";

const log = getLogger("conversation-lifecycle");

/**
 * Re-inject attachment path annotations into message content blocks.
 *
 * The LLM-facing content omits path annotations at persistence time, so we
 * re-inject them when loading history from the DB, from two metadata keys:
 * `imageSourcePaths` (where desktop-attached images came from) and
 * `attachmentStoredPaths` (the canonical, collision-suffixed copies in the
 * conversation's attachments/ directory), both keyed by
 * `${position}:${filename}`. The rebuilt block must stay byte-identical to
 * the one `enrichMessageWithSourcePaths` appends at persist time so reloads
 * and forks keep provider prefix-cache parity. Only user messages are
 * annotated.
 */
export function reinjectAttachmentPathAnnotations(
  content: ContentBlock[],
  role: string,
  metadataJson: string | null,
): ContentBlock[] {
  if (role !== "user" || !metadataJson) {
    return content;
  }
  try {
    const meta = JSON.parse(metadataJson);
    const lines: string[] = [];
    if (meta.imageSourcePaths && typeof meta.imageSourcePaths === "object") {
      for (const p of Object.values(meta.imageSourcePaths)) {
        if (typeof p === "string") {
          lines.push(formatImageSourceAnnotation(p));
        }
      }
    }
    if (
      meta.attachmentStoredPaths &&
      typeof meta.attachmentStoredPaths === "object"
    ) {
      for (const [key, p] of Object.entries(meta.attachmentStoredPaths)) {
        if (typeof p !== "string") {
          continue;
        }
        const filename = key.slice(key.indexOf(":") + 1);
        lines.push(formatStoredPathAnnotation(filename, p));
      }
    }
    if (lines.length === 0) {
      return content;
    }
    return [...content, { type: "text" as const, text: lines.join("\n") }];
  } catch {
    // metadata parse failure — skip annotation, not critical
    return content;
  }
}

// ── Context Interfaces ───────────────────────────────────────────────

export interface AbortContext {
  readonly conversationId: string;
  isProcessing(): boolean;
  setProcessing(value: boolean): void;
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
  readonly skillProjectionState: Map<string, string>;
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
    if (ctx.abortController) {
      // A live turn owns this controller. Signal it and let the agent loop's
      // own `finally` observe the abort, unwind, and clear the processing flag
      // — that path clears it with the correct sync-invalidation ordering
      // (after the awaited turn-boundary commit), so we deliberately do NOT
      // clear it here and risk clobbering a client's optimistic state.
      ctx.abortController.abort(effectiveReason);
    } else {
      // The flag is set but there is no live controller to signal: the turn
      // that owned it already tore its controller down (the agent-loop
      // `finally` nulls `abortController` before clearing the flag) or died
      // without ever installing one. Either way no agent-loop `finally` is
      // going to run to clear the flag. Without this branch the abort is a
      // silent no-op — `?.abort()` does nothing — and the conversation stays
      // wedged: every later submit is rejected with "already processing" and
      // Stop appears dead. Force-clear the flag directly so the conversation
      // frees up. `setProcessing(false)` also nulls the persisted column and
      // emits the metadata invalidation that drives clients to idle.
      log.warn(
        { conversationId: ctx.conversationId },
        "Abort requested while processing but no live abort controller — force-clearing stale processing flag",
      );
      ctx.setProcessing(false);
    }
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
  if (resolveCapabilities(ctx.trustContext?.trustClass).canAccessMemory) {
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

  // Release heavy in-memory data so GC can reclaim it
  ctx.messages = [];
  disposeToolProfiler(ctx.conversationId);
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
