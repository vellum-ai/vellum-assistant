export type CandidateType = "segment" | "item" | "summary" | "media";
export type CandidateSource = "semantic";

export type StalenessLevel = "fresh" | "aging" | "stale" | "very_stale";

export interface Candidate {
  key: string;
  type: CandidateType;
  id: string;
  source: CandidateSource;
  text: string;
  kind: string;
  modality?: "text" | "image" | "audio" | "video";
  /** The conversation this candidate originated from (segments only). */
  conversationId?: string;
  /** The source message ID this candidate was extracted from (segments only). */
  messageId?: string;
  confidence: number;
  importance: number;
  createdAt: number;
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
  semantic: number;
  recency: number;
}

export type DegradationReason =
  | "embedding_provider_down"
  | "qdrant_unavailable"
  | "embedding_generation_failed";

export interface DegradationStatus {
  semanticUnavailable: boolean;
  reason: DegradationReason;
  fallbackSources: string[];
}

export interface MemoryRecallResult {
  enabled: boolean;
  degraded: boolean;
  degradation?: DegradationStatus;
  reason?: string;
  provider?: string;
  model?: string;
  semanticHits: number;
  mergedCount: number;
  selectedCount: number;
  injectedTokens: number;
  injectedText: string;
  latencyMs: number;
  topCandidates: MemoryRecallCandiateDebug[];
  /** Count of tier 1 candidates after demotion. */
  tier1Count?: number;
  /** Count of tier 2 candidates after demotion. */
  tier2Count?: number;
  /** Milliseconds spent in the hybrid search step. */
  hybridSearchMs?: number;
  /** Whether sparse vectors were used in the hybrid search. */
  sparseVectorUsed?: boolean;
}

/**
 * Override the global scope policy for a single retrieval call.
 * Private conversations use this to guarantee they always read from their own
 * scope AND fall back to 'default', regardless of what the global config says.
 */
export interface ScopePolicyOverride {
  /** The primary scope to query (e.g. a private conversation's scope ID). */
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
   * for this retrieval call. Designed for private conversations that need to
   * guarantee private+default fallback independent of global settings.
   */
  scopePolicyOverride?: ScopePolicyOverride;
  maxInjectTokensOverride?: number;
}

export interface ItemMetadata {
  accessCount: number;
  lastUsedAt: number | null;
  verificationState: string;
  sourceConversationCount?: number;
}
