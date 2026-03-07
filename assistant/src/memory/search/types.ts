export type CandidateType = "segment" | "item" | "summary";
export type CandidateSource =
  | "lexical"
  | "semantic"
  | "recency"
  | "entity_direct"
  | "entity_relation"
  | "item_direct";

export interface Candidate {
  key: string;
  type: CandidateType;
  id: string;
  source: CandidateSource;
  text: string;
  kind: string;
  confidence: number;
  importance: number;
  createdAt: number;
  lexical: number;
  semantic: number;
  recency: number;
  finalScore: number;
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

export type FallbackSource = "lexical" | "recency" | "direct_item" | "entity";

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
  relationSeedEntityCount: number;
  relationTraversedEdgeCount: number;
  relationNeighborEntityCount: number;
  relationExpandedItemCount: number;
  earlyTerminated: boolean;
  mergedCount: number;
  selectedCount: number;
  rerankApplied: boolean;
  injectedTokens: number;
  injectedText: string;
  latencyMs: number;
  topCandidates: MemoryRecallCandiateDebug[];
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
  relationSeedEntityCount: number;
  relationTraversedEdgeCount: number;
  relationNeighborEntityCount: number;
  relationExpandedItemCount: number;
  earlyTerminated: boolean;
  /** True when semantic search was attempted but threw an error. */
  semanticSearchFailed: boolean;
  /** True when semantic search was known to be unavailable before retrieval (no vector or breaker open). */
  semanticUnavailable: boolean;
  merged: Candidate[];
}

export interface EntitySearchResult {
  candidates: Candidate[];
  relationSeedEntityCount: number;
  relationTraversedEdgeCount: number;
  relationNeighborEntityCount: number;
  relationExpandedItemCount: number;
  candidateDepths?: Map<string, number>; // candidate key → BFS hop depth (1-based)
}

export interface MatchedEntityRow {
  id: string;
  name: string;
  type: string;
  aliases: string | null;
  mention_count: number;
}

export interface ItemMetadata {
  accessCount: number;
  lastUsedAt: number | null;
  verificationState: string;
}

import type { EntityRelationType, EntityType } from "../entity-extractor.js";

export interface TraversalOptions {
  maxEdges: number;
  maxNeighborEntities: number;
  maxDepth?: number; // default 3
  relationTypes?: EntityRelationType[];
  entityTypes?: EntityType[];
  /** When true, only follow source→target edges (frontier must be on source side). */
  directed?: boolean;
}

export interface TraversalResult {
  neighborEntityIds: string[];
  traversedEdgeCount: number;
  neighborDepths: Map<string, number>; // entityId → depth (1-based)
}

export interface TraversalStep {
  relationTypes?: EntityRelationType[];
  entityTypes?: EntityType[];
}
