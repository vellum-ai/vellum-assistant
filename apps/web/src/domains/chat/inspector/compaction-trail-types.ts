/**
 * Types for the Compaction Trail API.
 *
 * Pinned to the **minimal shape** option for the data model decision:
 * a `compaction-trail` route returns `llm_request_logs` rows filtered
 * by `call_site = "compactionAgent"`, projected to the summary-level
 * fields the UI actually renders. The full request/response payloads
 * are not included — if the user wants to dig into one, they jump to
 * the existing per-call inspector view.
 *
 * If review reveals the UX needs structured outcome / before-after
 * counts that aren't in `llm_request_logs` (e.g. distinguishing
 * `unparseable` from `tail_unresolved`), we revisit the data model
 * before the daemon route lands.
 */

export interface CompactionTrailEvent {
  /** `llm_request_logs.id` for the underlying compaction LLM call. */
  id: string;
  /** Wall-clock timestamp of the compaction attempt, in ms epoch. */
  createdAt: number;
  /** Model used for the summarization call. */
  model: string | null;
  /** Provider that served the call. */
  provider: string | null;
  /**
   * Tokens of context the compactor sent. Proxy for "how much was in
   * the conversation when compaction fired".
   */
  inputTokens: number | null;
  /**
   * Tokens in the generated summary. 0 / null on provider error or
   * unparseable model output.
   */
  outputTokens: number | null;
  /** Wall-clock duration of the LLM call. */
  durationMs: number | null;
  /**
   * Truncated excerpt of the generated summary (first ~500 chars).
   * `null` when the call failed before producing output. The full
   * summary is available via the existing per-call inspector view at
   * `/inspect/:conversationId?callId=<id>`.
   */
  responsePreview: string | null;
  /** Number of messages in the request prompt. */
  requestMessageCount: number | null;
  /**
   * Provider stop reason. `end_turn` for a clean compaction;
   * `provider_error` / `max_tokens` / etc. surface failure modes.
   */
  stopReason: string | null;
  /** Cost of the compaction call. */
  estimatedCostUsd: number | null;
}

export interface CompactionTrailResponse {
  conversationId: string;
  /** Chronological list, oldest first. */
  events: CompactionTrailEvent[];
}
