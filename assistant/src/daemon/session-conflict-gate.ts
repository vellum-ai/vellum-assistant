/**
 * Conflict-gate logic extracted from Session.
 *
 * Decides whether to ask the user about a pending memory conflict (relevant gate),
 * inject a soft instruction (irrelevant gate), or skip entirely.
 */

import {
  applyConflictResolution,
  listPendingConflictDetails,
  markConflictAsked,
} from '../memory/conflict-store.js';
import type { PendingConflictDetail } from '../memory/conflict-store.js';
import { resolveConflictClarification } from '../memory/clarification-resolver.js';

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
  ): Promise<ConflictGateDecision | null> {
    if (!conflictConfig.enabled || conflictConfig.gateMode !== 'soft') return null;

    this.turnCounter += 1;
    const threshold = conflictConfig.relevanceThreshold;
    const cooldownTurns = Math.max(1, conflictConfig.reaskCooldownTurns);
    const pendingBeforeResolve = listPendingConflictDetails('default', 50);
    const candidatesBeforeResolve = pendingBeforeResolve.filter((conflict) => {
      const relevance = computeConflictRelevance(userMessage, conflict);
      if (relevance >= threshold) return true;
      // Only try to resolve recently-asked conflicts when the user message
      // looks like a short clarification reply (e.g. "keep the new one"),
      // not a full unrelated question that happens to contain cue words.
      return this.wasRecentlyAsked(conflict.id, cooldownTurns)
        && looksLikeClarificationReply(userMessage);
    });
    await this.resolvePendingConflicts(
      userMessage,
      conflictConfig.resolverLlmTimeoutMs,
      candidatesBeforeResolve,
    );

    const pending = listPendingConflictDetails('default', 50);
    if (pending.length === 0) return null;

    const scored = pending.map((conflict) => ({
      conflict,
      relevance: computeConflictRelevance(userMessage, conflict),
    }));
    const relevant = scored.filter((entry) => entry.relevance >= threshold);
    const irrelevant = scored.filter((entry) => entry.relevance < threshold);
    const ordered = [...relevant, ...irrelevant];

    const askable = ordered.find((entry) => this.shouldAsk(entry.conflict.id, cooldownTurns));
    if (!askable) return null;

    this.lastAskedTurn.set(askable.conflict.id, this.turnCounter);
    markConflictAsked(askable.conflict.id);
    return {
      question: askable.conflict.clarificationQuestion ?? buildFallbackConflictQuestion(askable.conflict),
      relevant: askable.relevance >= threshold,
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

export function computeConflictRelevance(
  userMessage: string,
  conflict: Pick<PendingConflictDetail, 'existingStatement' | 'candidateStatement'>,
): number {
  const queryTokens = tokenizeForConflictRelevance(userMessage);
  if (queryTokens.size === 0) return 0;
  const existingTokens = tokenizeForConflictRelevance(conflict.existingStatement);
  const candidateTokens = tokenizeForConflictRelevance(conflict.candidateStatement);
  return Math.max(
    overlapRatio(queryTokens, existingTokens),
    overlapRatio(queryTokens, candidateTokens),
  );
}

function tokenizeForConflictRelevance(input: string): Set<string> {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  return new Set(tokens);
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

// Action verbs that signal the user is making a deliberate choice.
const ACTION_CUES = new Set([
  'keep', 'use', 'prefer', 'go', 'pick', 'choose', 'take', 'want', 'select',
]);

// Directional/merge cue words mirrored from clarification-resolver.ts heuristics.
const DIRECTIONAL_CUES = new Set([
  'existing', 'old', 'previous', 'first', 'earlier', 'original',
  'candidate', 'new', 'latest', 'second', 'updated', 'instead', 'replace',
  'both', 'merge', 'combine', 'together', 'either', 'mix',
  'option', 'former', 'latter',
]);

const MAX_REPLY_WORD_COUNT = 12;

/**
 * Determines whether a user message looks like a deliberate reply to a
 * recently asked conflict clarification (e.g. "keep the new one", "option B").
 * Requires both an action cue and a directional cue, and the message must be
 * short. Questions and longer statements are excluded to prevent accidental
 * resolution from messages like "what's new in Bun?".
 */
export function looksLikeClarificationReply(userMessage: string): boolean {
  const trimmed = userMessage.trim();
  if (trimmed.endsWith('?')) return false;

  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_REPLY_WORD_COUNT) return false;

  const normalized = words.map((w) => w.replace(/[^a-z]/g, ''));
  const hasAction = normalized.some((w) => ACTION_CUES.has(w));
  const hasDirection = normalized.some((w) => DIRECTIONAL_CUES.has(w));
  return hasAction && hasDirection;
}
