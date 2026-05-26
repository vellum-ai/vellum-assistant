/**
 * Mock compaction trail data + simulated fetch.
 *
 * This module exists for one reason: validate the Compaction tab UX
 * before we lock the data model. Today the daemon doesn't expose a
 * `compaction-trail` route — when it does, the swap is one import in
 * `compaction-trail-api.ts`.
 *
 * The shape returned here is the **minimal** option from
 * `llm_request_logs` filtered by `call_site = "compactionAgent"`. If
 * this UI feels thin during review, that's our signal that the new
 * `compaction_logs` table (or a structured JSON column on
 * `llm_request_logs`) earns its keep. If it feels sufficient, we ship
 * the API route against the existing column and save ourselves a
 * migration.
 *
 * Mock latency (250ms) simulates the network so the loading state is
 * visible in dev.
 */

import type {
  CompactionTrailEvent,
  CompactionTrailResponse,
} from "./compaction-trail-types.js";

const MOCK_LATENCY_MS = 250;

/**
 * Fabricated events spanning ~90 minutes of a long-running conversation.
 * Token counts roughly match what a real ~190k-context compaction
 * produces (180k+ input shrinks to a 3-5k summary). The final event is
 * an error so the UI surfaces a failure state out of the box.
 */
const MOCK_EVENTS: CompactionTrailEvent[] = [
  {
    id: "compaction-mock-1",
    createdAt: Date.parse("2026-05-26T15:32:11Z"),
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    inputTokens: 184_231,
    outputTokens: 4_872,
    durationMs: 8_412,
    responsePreview:
      "User is debugging a flaky CI job on the inspector test suite. Established that the flake is timing-related and only reproduces under -p1. Tried adjusting timeouts (no effect) and isolating the offending describe block (narrowed to `aggregateSkillLoads`). Currently investigating whether the aggregator's sort is non-stable when two loads share a timestamp.",
    requestMessageCount: 142,
    stopReason: "end_turn",
    estimatedCostUsd: 0.62,
  },
  {
    id: "compaction-mock-2",
    createdAt: Date.parse("2026-05-26T15:54:38Z"),
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    inputTokens: 178_904,
    outputTokens: 3_211,
    durationMs: 6_984,
    responsePreview:
      "Continuing from the previous compaction: pinned the flake to `Array.prototype.sort` stability assumptions across Bun versions. Patched the comparator to break ties on `logId` and the test now passes 100/100 runs.",
    requestMessageCount: 96,
    stopReason: "end_turn",
    estimatedCostUsd: 0.48,
  },
  {
    id: "compaction-mock-3",
    createdAt: Date.parse("2026-05-26T16:18:02Z"),
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    inputTokens: 191_018,
    outputTokens: 5_134,
    durationMs: 9_211,
    responsePreview:
      "Pivoted to a new task: add a Compaction Trail tab to the inspector. Reviewed existing tab structure (overview/prompt/response/raw/skills/memory). Decided on a chronological per-conversation timeline with expandable summary excerpts. Mock data is in flight to validate UX before locking the API contract.",
    requestMessageCount: 168,
    stopReason: "end_turn",
    estimatedCostUsd: 0.71,
  },
  {
    id: "compaction-mock-4",
    createdAt: Date.parse("2026-05-26T16:41:47Z"),
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    inputTokens: 187_452,
    outputTokens: 0,
    durationMs: 14_902,
    responsePreview: null,
    requestMessageCount: 154,
    stopReason: "provider_error",
    estimatedCostUsd: 0.0,
  },
  {
    id: "compaction-mock-5",
    createdAt: Date.parse("2026-05-26T16:43:12Z"),
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    inputTokens: 187_452,
    outputTokens: 4_408,
    durationMs: 7_521,
    responsePreview:
      "Retry after provider error. Same context as the previous attempt — compactor backed off and re-issued. Summary captures the same conversation state and the assistant resumed from this checkpoint.",
    requestMessageCount: 154,
    stopReason: "end_turn",
    estimatedCostUsd: 0.55,
  },
];

export async function fetchCompactionTrailMock(
  conversationId: string,
  signal: AbortSignal | undefined,
): Promise<CompactionTrailResponse> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, MOCK_LATENCY_MS);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      });
    }
  });
  return {
    conversationId,
    events: MOCK_EVENTS,
  };
}
