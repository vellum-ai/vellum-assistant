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
  semantic: number;
  recency: number;
}

export interface MemoryRecalled {
  type: "memory_recalled";
  provider: string;
  model: string;
  degradation?: MemoryRecalledDegradation;
  semanticHits: number;
  tier1Count: number;
  tier2Count: number;
  hybridSearchLatencyMs: number;
  sparseVectorUsed: boolean;
  mergedCount: number;
  selectedCount: number;
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
}

// --- Domain-level union aliases (consumed by the barrel file) ---
// Memory has no client messages.

export type _MemoryServerMessages = MemoryRecalled | MemoryStatus;
