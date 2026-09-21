import type { RecallSource } from "../../../../api/events/tool-result.js";
import type { AssistantConfig } from "../../../../config/schema.js";

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
