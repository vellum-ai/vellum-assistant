/**
 * Conflict-gate logic extracted from Session.
 *
 * Handles pending memory conflicts internally: dismisses non-user-evidenced
 * and non-actionable conflicts, and attempts resolution when the user's reply
 * looks like an explicit clarification with topical relevance. Never produces
 * user-facing clarification text.
 */

import { resolveConflictClarification } from "../memory/clarification-resolver.js";
import {
  areStatementsCoherent,
  computeConflictRelevance,
  looksLikeClarificationReply,
  shouldAttemptConflictResolution,
} from "../memory/conflict-intent.js";
import {
  isConflictKindPairEligible,
  isConflictUserEvidenced,
  isStatementConflictEligible,
} from "../memory/conflict-policy.js";
import type { PendingConflictDetail } from "../memory/conflict-store.js";
import {
  applyConflictResolution,
  listPendingConflictDetails,
  resolveConflict,
} from "../memory/conflict-store.js";

export class ConflictGate {
  async evaluate(
    userMessage: string,
    conflictConfig: {
      enabled: boolean;
      gateMode: string;
      relevanceThreshold: number;
      resolverLlmTimeoutMs: number;
      conflictableKinds: readonly string[];
    },
    scopeId = "default",
  ): Promise<void> {
    if (!conflictConfig.enabled || conflictConfig.gateMode !== "soft") return;

    const pendingBeforeResolve = listPendingConflictDetails(scopeId, 50);

    // Dismiss non-actionable conflicts (kind/statement policy, incoherent pair,
    // or assistant-inferred-only provenance with no user evidence)
    const dismissedIds = new Set<string>();
    for (const conflict of pendingBeforeResolve) {
      const dismissReason = this.getDismissReason(
        conflict,
        conflictConfig.conflictableKinds,
      );
      if (dismissReason) {
        resolveConflict(conflict.id, {
          status: "dismissed",
          resolutionNote: dismissReason,
        });
        dismissedIds.add(conflict.id);
      }
    }

    const actionablePending = pendingBeforeResolve.filter(
      (c) => !dismissedIds.has(c.id),
    );

    // Attempt resolution only for explicit clarification-like replies with
    // topical relevance to the conflict statements
    const clarificationReply = looksLikeClarificationReply(userMessage);
    const candidatesBeforeResolve = actionablePending.filter((conflict) => {
      const relevance = computeConflictRelevance(userMessage, conflict);
      return shouldAttemptConflictResolution({
        clarificationReply,
        relevance,
      });
    });
    await this.resolvePendingConflicts(
      userMessage,
      conflictConfig.resolverLlmTimeoutMs,
      candidatesBeforeResolve,
    );
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
      if (resolution.resolution === "still_unclear") continue;

      applyConflictResolution({
        conflictId: conflict.id,
        resolution: resolution.resolution,
        mergedStatement:
          resolution.resolution === "merge"
            ? resolution.resolvedStatement
            : null,
        resolutionNote: resolution.explanation,
      });
    }
  }

  /**
   * Returns a dismissal reason if the conflict should be dismissed, or null if actionable.
   */
  private getDismissReason(
    conflict: PendingConflictDetail,
    conflictableKinds: readonly string[],
  ): string | null {
    if (
      !isConflictKindPairEligible(
        conflict.existingKind,
        conflict.candidateKind,
        { conflictableKinds },
      )
    ) {
      return "Dismissed by conflict policy (kind not eligible).";
    }
    if (
      !isStatementConflictEligible(
        conflict.existingKind,
        conflict.existingStatement,
        { conflictableKinds },
      )
    ) {
      return "Dismissed by conflict policy (transient/non-durable).";
    }
    if (
      !isStatementConflictEligible(
        conflict.candidateKind,
        conflict.candidateStatement,
        { conflictableKinds },
      )
    ) {
      return "Dismissed by conflict policy (transient/non-durable).";
    }
    // Dismiss incoherent conflicts where the two statements have zero topical overlap
    if (
      !areStatementsCoherent(
        conflict.existingStatement,
        conflict.candidateStatement,
      )
    ) {
      return "Dismissed by conflict policy (incoherent — zero statement overlap).";
    }
    // Dismiss conflicts where neither side has user-evidenced provenance
    if (
      !isConflictUserEvidenced(
        conflict.existingVerificationState,
        conflict.candidateVerificationState,
      )
    ) {
      return "Dismissed by conflict policy (no user-evidenced provenance).";
    }
    return null;
  }
}

export { computeConflictRelevance, looksLikeClarificationReply };
