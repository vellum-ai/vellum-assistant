/**
 * Conflict-gate logic extracted from Session.
 *
 * Decides whether to ask the user about a pending memory conflict (relevant gate)
 * or skip entirely.
 */

import {
  applyConflictResolution,
  listPendingConflictDetails,
  markConflictAsked,
} from '../memory/conflict-store.js';
import type { PendingConflictDetail } from '../memory/conflict-store.js';
import { resolveConflictClarification } from '../memory/clarification-resolver.js';
import {
  computeConflictRelevance,
  looksLikeClarificationReply,
  shouldAttemptConflictResolution,
} from '../memory/conflict-intent.js';

export interface ConflictGateDecision {
  question: string;
  relevant: boolean;
}

export class ConflictGate {
  private turnCounter = 0;
  private lastAskedTurn = new Map<string, number>();

  async evaluate(
    userMessage: string,
    conflictConfig: {
      enabled: boolean;
      gateMode: string;
      relevanceThreshold: number;
      reaskCooldownTurns: number;
      resolverLlmTimeoutMs: number;
    },
    scopeId = 'default',
  ): Promise<ConflictGateDecision | null> {
    if (!conflictConfig.enabled || conflictConfig.gateMode !== 'soft') return null;

    this.turnCounter += 1;
    const threshold = conflictConfig.relevanceThreshold;
    const cooldownTurns = Math.max(1, conflictConfig.reaskCooldownTurns);
    const pendingBeforeResolve = listPendingConflictDetails(scopeId, 50);
    const clarificationReply = looksLikeClarificationReply(userMessage);
    const candidatesBeforeResolve = pendingBeforeResolve.filter((conflict) => {
      const relevance = computeConflictRelevance(userMessage, conflict);
      return shouldAttemptConflictResolution({
        clarificationReply,
        relevance,
        wasRecentlyAsked: this.wasRecentlyAsked(conflict.id, cooldownTurns),
      });
    });
    await this.resolvePendingConflicts(
      userMessage,
      conflictConfig.resolverLlmTimeoutMs,
      candidatesBeforeResolve,
    );

    const pending = listPendingConflictDetails(scopeId, 50);
    if (pending.length === 0) return null;

    const scored = pending.map((conflict) => ({
      conflict,
      relevance: computeConflictRelevance(userMessage, conflict),
    }));
    const askable = scored
      .filter((entry) => entry.relevance >= threshold)
      .find((entry) => this.shouldAsk(entry.conflict.id, cooldownTurns));
    if (!askable) return null;

    this.lastAskedTurn.set(askable.conflict.id, this.turnCounter);
    markConflictAsked(askable.conflict.id);
    return {
      question: askable.conflict.clarificationQuestion ?? buildFallbackConflictQuestion(askable.conflict),
      relevant: true,
    };
  }

  private async resolvePendingConflicts(
    userMessage: string,
    resolverTimeoutMs: number,
    pendingConflicts: PendingConflictDetail[],
  ): Promise<void> {
    for (const conflict of pendingConflicts) {
      const resolution = await resolveConflictClarification(
        {
          existingStatement: conflict.existingStatement,
          candidateStatement: conflict.candidateStatement,
          userMessage,
        },
        { timeoutMs: resolverTimeoutMs },
      );
      if (resolution.resolution === 'still_unclear') continue;

      applyConflictResolution({
        conflictId: conflict.id,
        resolution: resolution.resolution,
        mergedStatement: resolution.resolution === 'merge' ? resolution.resolvedStatement : null,
        resolutionNote: resolution.explanation,
      });
    }
  }

  private shouldAsk(conflictId: string, cooldownTurns: number): boolean {
    const lastAsked = this.lastAskedTurn.get(conflictId);
    if (lastAsked === undefined) return true;
    return this.turnCounter - lastAsked >= cooldownTurns;
  }

  private wasRecentlyAsked(conflictId: string, cooldownTurns: number): boolean {
    const lastAsked = this.lastAskedTurn.get(conflictId);
    if (lastAsked === undefined) return false;
    return this.turnCounter - lastAsked <= cooldownTurns;
  }
}

export function buildFallbackConflictQuestion(conflict: PendingConflictDetail): string {
  return [
    'I have two conflicting notes and need your confirmation.',
    `A) ${conflict.existingStatement}`,
    `B) ${conflict.candidateStatement}`,
    'Which one should I keep?',
  ].join('\n');
}
export { computeConflictRelevance, looksLikeClarificationReply };
