import type { AssistantConfig } from "../../config/schema.js";

export type RecallSource = "memory" | "pkb" | "conversations" | "workspace";

export type RecallDepth = "fast" | "standard" | "deep";

export interface RecallInput {
  query: string;
  sources?: RecallSource[];
  max_results?: number;
  depth?: RecallDepth;
}

export interface RecallEvidence {
  id: string;
  source: RecallSource;
  title: string;
  locator: string;
  excerpt: string;
  timestampMs?: number;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface RecallSearchContext {
  workingDir: string;
  memoryScopeId: string;
  conversationId: string;
  config: AssistantConfig;
  signal?: AbortSignal;
}

export interface RecallSearchResult {
  evidence: RecallEvidence[];
}

export interface RecallAnswer {
  answer: string;
  evidence: RecallEvidence[];
}

export interface RecallSourceAdapter {
  source: RecallSource;
  search(
    query: string,
    context: RecallSearchContext,
    limit: number,
  ): Promise<RecallSearchResult>;
}
