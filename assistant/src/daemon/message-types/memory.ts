// Memory recall and status types.

export interface MemoryRecalledDegradation {
  semanticUnavailable: boolean;
  reason: string;
  fallbackSources: string[];
}

export interface MemoryRecalledCandidateDebug {
  key: string;
  type: string;
  kind: string;
  finalScore: number;
  lexical: number;
  semantic: number;
  recency: number;
}

export interface MemoryRecalled {
  type: "memory_recalled";
  provider: string;
  model: string;
  degradation?: MemoryRecalledDegradation;
  lexicalHits: number;
  semanticHits: number;
  recencyHits: number;
  entityHits: number;
  relationSeedEntityCount?: number;
  relationTraversedEdgeCount?: number;
  relationNeighborEntityCount?: number;
  relationExpandedItemCount?: number;
  earlyTerminated?: boolean;
  mergedCount: number;
  selectedCount: number;
  rerankApplied: boolean;
  injectedTokens: number;
  latencyMs: number;
  topCandidates: MemoryRecalledCandidateDebug[];
}

export interface MemoryStatus {
  type: "memory_status";
  enabled: boolean;
  degraded: boolean;
  degradation?: MemoryRecalledDegradation;
  reason?: string;
  provider?: string;
  model?: string;
  conflictsPending: number;
  conflictsResolved: number;
  oldestPendingConflictAgeMs: number | null;
  cleanupResolvedJobsPending: number;
  cleanupSupersededJobsPending: number;
  cleanupResolvedJobsCompleted24h: number;
  cleanupSupersededJobsCompleted24h: number;
}

// --- Domain-level union aliases (consumed by the barrel file) ---
// Memory has no client messages.

export type _MemoryServerMessages = MemoryRecalled | MemoryStatus;
