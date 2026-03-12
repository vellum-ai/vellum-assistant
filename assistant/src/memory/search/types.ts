export type CandidateType = "segment" | "item" | "summary" | "media";
export type CandidateSource =
  | "lexical"
  | "semantic"
  | "recency"
  | "item_direct";

export type StalenessLevel = "fresh" | "aging" | "stale" | "very_stale";

export interface Candidate {
  key: string;
  type: CandidateType;
  id: string;
  source: CandidateSource;
  text: string;
  kind: string;
  modality?: "text" | "image" | "audio" | "video";
  confidence: number;
  importance: number;
  createdAt: number;
  lexical: number;
  semantic: number;
  recency: number;
  finalScore: number;
  tier?: 1 | 2 | null;
  staleness?: StalenessLevel;
}

export interface MemoryRecallCandiateDebug {
  key: string;
  type: CandidateType;
  kind: string;
  finalScore: number;
  lexical: number;
  semantic: number;
  recency: number;
}

export type DegradationReason =
  | "embedding_provider_down"
  | "qdrant_unavailable"
  | "embedding_generation_failed";

export type FallbackSource = "lexical" | "recency" | "direct_item";

export interface DegradationStatus {
  semanticUnavailable: boolean;
  reason: DegradationReason;
  fallbackSources: FallbackSource[];
}

export interface MemoryRecallResult {
  enabled: boolean;
  degraded: boolean;
  degradation?: DegradationStatus;
  reason?: string;
  provider?: string;
  model?: string;
  lexicalHits: number;
  semanticHits: number;
  recencyHits: number;
  entityHits: number;
  /** @deprecated Entity search removed — always 0. Kept for log format compat. */
  relationSeedEntityCount: number;
  /** @deprecated Entity search removed — always 0. Kept for log format compat. */
  relationTraversedEdgeCount: number;
  /** @deprecated Entity search removed — always 0. Kept for log format compat. */
  relationNeighborEntityCount: number;
  /** @deprecated Entity search removed — always 0. Kept for log format compat. */
  relationExpandedItemCount: number;
  earlyTerminated: boolean;
  mergedCount: number;
  selectedCount: number;
  rerankApplied: boolean;
  injectedTokens: number;
  injectedText: string;
  latencyMs: number;
  topCandidates: MemoryRecallCandiateDebug[];
  /** V2 pipeline: count of tier 1 candidates after demotion. */
  tier1Count?: number;
  /** V2 pipeline: count of tier 2 candidates after demotion. */
  tier2Count?: number;
  /** V2 pipeline: milliseconds spent in the hybrid search step. */
  hybridSearchMs?: number;
}

/**
 * Override the global scope policy for a single retrieval call.
 * Private threads use this to guarantee they always read from their own
 * scope AND fall back to 'default', regardless of what the global config says.
 */
export interface ScopePolicyOverride {
  /** The primary scope to query (e.g. a private thread's scope ID). */
  scopeId: string;
  /** When true, results from the 'default' scope are included alongside
   *  the primary scope. Equivalent to 'allow_global_fallback' behavior
   *  but controlled per-call instead of globally. */
  fallbackToDefault: boolean;
}

export interface MemoryRecallOptions {
  excludeMessageIds?: string[];
  signal?: AbortSignal;
  scopeId?: string;
  /**
   * When set, overrides both `scopeId` and the global `scopePolicy` config
   * for this retrieval call. Designed for private threads that need to
   * guarantee private+default fallback independent of global settings.
   */
  scopePolicyOverride?: ScopePolicyOverride;
  maxInjectTokensOverride?: number;
}

export interface CollectedCandidates {
  lexical: Candidate[];
  recency: Candidate[];
  semantic: Candidate[];
  entity: Candidate[];
  earlyTerminated: boolean;
  /** True when semantic search was attempted but threw an error. */
  semanticSearchFailed: boolean;
  /** True when semantic search was known to be unavailable before retrieval (no vector or breaker open). */
  semanticUnavailable: boolean;
  /** The error that caused semantic search to fail, if any. */
  semanticSearchError?: unknown;
  merged: Candidate[];
}

export interface ItemMetadata {
  accessCount: number;
  lastUsedAt: number | null;
  verificationState: string;
  sourceConversationCount?: number;
}
