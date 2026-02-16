export type CandidateType = 'segment' | 'item' | 'summary';
export type CandidateSource =
  | 'lexical'
  | 'semantic'
  | 'recency'
  | 'entity_direct'
  | 'entity_relation'
  | 'item_direct';

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

export interface MemoryRecallResult {
  enabled: boolean;
  degraded: boolean;
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

export interface MemoryRecallOptions {
  excludeMessageIds?: string[];
  signal?: AbortSignal;
  scopeId?: string;
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
  merged: Candidate[];
}

export interface EntitySearchResult {
  candidates: Candidate[];
  relationSeedEntityCount: number;
  relationTraversedEdgeCount: number;
  relationNeighborEntityCount: number;
  relationExpandedItemCount: number;
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

export interface MemorySearchResult {
  id: string;
  type: CandidateType;
  kind: string;
  text: string;
  confidence: number;
  importance: number;
  createdAt: number;
  finalScore: number;
  /** Per-source scores for provenance/debugging */
  scores: {
    lexical: number;
    semantic: number;
    recency: number;
  };
}
