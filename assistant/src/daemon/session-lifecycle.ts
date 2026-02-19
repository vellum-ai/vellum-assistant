/**
 * Session lifecycle methods extracted from Session: loadFromDb, abort,
 * and dispose. Each operates on a context interface so the Session class
 * can delegate without exposing its full surface.
 */

import type { Message, ContentBlock } from '../providers/types.js';
import type { UsageStats, SurfaceType, SurfaceData } from './ipc-protocol.js';
import { repairHistory } from './history-repair.js';
import { createContextSummaryMessage } from '../context/window-manager.js';
import * as conversationStore from '../memory/conversation-store.js';
import type { PermissionPrompter } from '../permissions/prompter.js';
import type { SecretPrompter } from '../permissions/secret-prompter.js';
import type { ToolProfiler } from '../events/tool-profiling-listener.js';
import type { EventBus } from '../events/bus.js';
import type { AssistantDomainEvents } from '../events/domain-events.js';
import type { MessageQueue } from './session-queue-manager.js';
import { getHookManager } from '../hooks/manager.js';
import { getLogger } from '../util/logger.js';
import { unregisterWatchNotifiers, unregisterCallNotifiers } from './session-notifiers.js';
import { unregisterSessionSender } from '../tools/browser/browser-screencast.js';
import { resetSkillToolProjection } from './session-skill-tools.js';

const log = getLogger('session-lifecycle');

// ── Context Interfaces ───────────────────────────────────────────────

export interface LoadFromDbContext {
  readonly conversationId: string;
  messages: Message[];
  usageStats: UsageStats;
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
}

export interface AbortContext {
  readonly conversationId: string;
  processing: boolean;
  abortController: AbortController | null;
  prompter: PermissionPrompter;
  secretPrompter: SecretPrompter;
  pendingSurfaceActions: Map<string, { surfaceType: SurfaceType }>;
  surfaceState: Map<string, { surfaceType: SurfaceType; data: SurfaceData }>;
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
  abort(): void;
}

// ── loadFromDb ───────────────────────────────────────────────────────

export async function loadFromDb(ctx: LoadFromDbContext): Promise<void> {
  const dbMessages = conversationStore.getMessages(ctx.conversationId);

  const conv = conversationStore.getConversation(ctx.conversationId);
  const contextSummary = conv?.contextSummary?.trim() || null;
  ctx.contextCompactedMessageCount = Math.max(
    0,
    Math.min(conv?.contextCompactedMessageCount ?? 0, dbMessages.length),
  );
  ctx.contextCompactedAt = conv?.contextCompactedAt ?? null;

  const parsedMessages: Message[] = dbMessages
    .slice(ctx.contextCompactedMessageCount)
    .map((m) => {
      const role = m.role as 'user' | 'assistant';
      let content: ContentBlock[];
      try {
        const parsed = JSON.parse(m.content);
        content = Array.isArray(parsed) ? parsed : [{ type: 'text', text: m.content }];
      } catch {
        log.warn({ conversationId: ctx.conversationId, messageId: m.id }, 'Invalid JSON in persisted message content, replacing with safe text block');
        content = [{ type: 'text', text: m.content }];
      }
      return { role, content };
    });

  const { messages: repairedMessages, stats } = repairHistory(parsedMessages);
  if (stats.assistantToolResultsMigrated > 0 || stats.missingToolResultsInserted > 0 || stats.orphanToolResultsDowngraded > 0 || stats.consecutiveSameRoleMerged > 0) {
    log.warn({ conversationId: ctx.conversationId, phase: 'load', ...stats }, 'Repaired persisted history');
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

  log.info({ conversationId: ctx.conversationId, count: ctx.messages.length }, 'Loaded messages from DB');
}

// ── abort ─────────────────────────────────────────────────────────────

export function abortSession(ctx: AbortContext): void {
  if (ctx.processing) {
    log.info({ conversationId: ctx.conversationId }, 'Aborting in-flight processing');
    ctx.abortController?.abort();
    ctx.prompter.dispose();
    ctx.secretPrompter.dispose();
    ctx.pendingSurfaceActions.clear();
    ctx.surfaceState.clear();
    unregisterWatchNotifiers(ctx.conversationId);
    for (const queued of ctx.queue) {
      queued.onEvent({ type: 'generation_cancelled', sessionId: ctx.conversationId });
    }
    ctx.queue.clear();
  }
}

// ── dispose ──────────────────────────────────────────────────────────

export function disposeSession(ctx: DisposeContext): void {
  void getHookManager().trigger('session-end', {
    sessionId: ctx.conversationId,
  });
  ctx.abort();
  unregisterCallNotifiers(ctx.conversationId);
  unregisterSessionSender(ctx.conversationId);
  resetSkillToolProjection(ctx.skillProjectionState);
  ctx.eventBus.dispose();

  // Release heavy in-memory data so GC can reclaim it
  ctx.messages = [];
  ctx.profiler.clear();
  ctx.surfaceUndoStacks.clear();
  ctx.currentTurnSurfaces = [];
  ctx.pendingSurfaceActions.clear();
  ctx.surfaceState.clear();
  ctx.lastSurfaceAction.clear();
  ctx.workspaceTopLevelContext = null;
}
