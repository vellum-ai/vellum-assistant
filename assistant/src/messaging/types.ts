export interface ThreadMessage {
  id: string;
  sender: string;
  body: string;
  timestamp: number;       // epoch ms
  channel: string;         // email, slack, whatsapp, etc.
  metadata?: Record<string, unknown>;
}

export interface ThreadSummary {
  summary: string;
  participants: Array<{ name: string; role?: string }>;
  openQuestions: string[];
  lastAction: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  messageCount: number;
}

// ── Inbound Message (channel-agnostic) ──────────────────────────────

export interface InboundMessage {
  channel: string;
  sender: string;
  subject?: string;
  body: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

// ── Triage Result ───────────────────────────────────────────────────

export interface TriageResult {
  category: string;
  confidence: number;
  suggestedAction: string;
  matchedPlaybooks: Array<{
    trigger: string;
    action: string;
    autonomyLevel: string;
  }>;
}

/**
 * Default triage categories. These are suggestions, not a closed set --
 * the LLM classifier may return any category string.
 */
export const DEFAULT_TRIAGE_CATEGORIES = [
  'needs_response',
  'fyi',
  'newsletter',
  'cold_outreach',
  'transactional',
  'urgent',
  'scheduling',
] as const;
