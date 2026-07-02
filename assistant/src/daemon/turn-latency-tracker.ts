/**
 * Per-turn first-token latency instrumentation.
 *
 * A single tracker is created at turn start and threaded through both the
 * orchestrator (`conversation-agent-loop.ts`, which stamps the turn-level
 * marks: queue + memory/context retrieval) and the agent loop
 * (`agent/loop.ts`, which stamps the per-call marks: tool resolution →
 * request sent → first token → call complete). When a call's `usage`
 * event lands, `handleUsage` serializes the marks for that call into a
 * {@link LatencyBreakdown} and persists it on the `llm_request_logs` row,
 * where the inspector renders it.
 *
 * A phase is the span between two consecutive marks, labeled by the mark
 * that *closes* it — so the exact interleaving of work between marks does
 * not matter, only that the marks land in execution order.
 */

import type {
  LatencyBreakdown,
  LatencyPhase,
} from "../api/responses/llm-request-log-entry.js";

/** Canonical mark names, in the order they fire on the first call of a turn. */
export type LatencyMark =
  | "turn_start"
  | "prompt_hook_start"
  | "prompt_hook_end"
  | "tools_resolved"
  | "request_sent"
  | "first_token"
  | "call_complete";

/**
 * Phase metadata keyed by the mark that closes the span. A mark with no
 * entry here (e.g. `turn_start`, which only opens the first phase) emits
 * no phase of its own.
 */
const PHASE_BY_CLOSING_MARK: Record<string, { key: string; label: string }> = {
  prompt_hook_start: { key: "queue", label: "Queue & turn setup" },
  prompt_hook_end: {
    key: "memory_context",
    label: "Memory & context retrieval",
  },
  tools_resolved: { key: "setup", label: "Budget gate & tool resolution" },
  request_sent: { key: "request_prep", label: "Request prep" },
  first_token: { key: "ttft", label: "Time to first token" },
  call_complete: { key: "generation", label: "Generation" },
};

export class TurnLatencyTracker {
  private readonly marks: {
    name: string;
    at: number;
    kind?: "thinking" | "text";
  }[] = [];

  /** Stamp a point-in-time mark. Cheap (`Date.now()`); safe to over-call. */
  mark(name: LatencyMark): void {
    // A retried provider call re-issues `request_sent`; drop the failed
    // attempt's stale marks first so the retry's segment measures only itself.
    if (name === "request_sent") this.supersedeFailedAttempt();
    this.marks.push({ name, at: Date.now() });
  }

  /**
   * Discard the per-call marks of a prior provider attempt that never
   * completed. A call retried within the same turn (context-overflow recovery,
   * post-model-call repair on a rejection) leaves a `request_sent` with no
   * `call_complete` and no `usage` event to serialize it and advance the
   * cursor; the next successful segment would otherwise measure ttft /
   * provider-duration / phases from the failed attempt's marks.
   *
   * Detection is cursor-free: a completed call always stamps `call_complete`
   * before its `usage` event, so a `request_sent` with none after it belongs
   * to a call that never returned. A retry re-stamps its setup `tools_resolved`
   * before this `request_sent`, so that trailing mark is preserved as the
   * successful segment's setup mark.
   */
  private supersedeFailedAttempt(): void {
    let failedRequestSent = -1;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const name = this.marks[i]!.name;
      if (name === "call_complete") return; // prior attempt finished — nothing stale
      if (name === "request_sent") {
        failedRequestSent = i;
        break;
      }
    }
    if (failedRequestSent === -1) return; // no prior attempt this turn
    // Drop from the failed attempt's paired setup mark (its `tools_resolved`,
    // if any) through its trailing marks, keeping a retry `tools_resolved`
    // already stamped as the last mark.
    let start = failedRequestSent;
    if (this.marks[start - 1]?.name === "tools_resolved") start -= 1;
    let end = this.marks.length;
    if (this.marks[end - 1]!.name === "tools_resolved") end -= 1;
    this.marks.splice(start, end - start);
  }

  /**
   * Stamp the first streamed token of the current call, carrying its kind on
   * the mark. The caller fires this once per call (guarded loop-side), so each
   * per-call segment gets its own `first_token` mark and kind.
   */
  markFirstToken(kind: "thinking" | "text"): void {
    this.marks.push({ name: "first_token", at: Date.now(), kind });
  }

  /**
   * Serialize the breakdown for the call segment beginning at `cursor` (an
   * index into the mark list). Emits one phase per mark from `cursor` to the
   * end, each measured against its predecessor, and returns the next cursor
   * (the new mark count) so the following call serializes only its own
   * segment. Returns a `null` breakdown when there is nothing to report.
   */
  serializeSince(cursor: number): {
    breakdown: LatencyBreakdown | null;
    cursor: number;
  } {
    const end = this.marks.length;
    if (end === 0 || cursor >= end) return { breakdown: null, cursor: end };

    const phases: LatencyPhase[] = [];
    // Start at max(cursor, 1): the first mark of the whole turn has no
    // predecessor to measure against, and a mid-turn segment's first phase
    // is measured against the previous segment's last mark (index cursor-1).
    for (let i = Math.max(cursor, 1); i < end; i++) {
      const meta = PHASE_BY_CLOSING_MARK[this.marks[i]!.name];
      if (!meta) continue;
      const ms = this.marks[i]!.at - this.marks[i - 1]!.at;
      // A non-monotonic clock would yield a negative span; drop it rather
      // than render misleading noise.
      if (ms < 0) continue;
      phases.push({ key: meta.key, label: meta.label, ms });
    }
    if (phases.length === 0) return { breakdown: null, cursor: end };

    const breakdown: LatencyBreakdown = { phases };
    const requestSent = this.findMarkFrom("request_sent", cursor)?.at;
    const firstTokenMark = this.findMarkFrom("first_token", cursor);
    const firstToken = firstTokenMark?.at;
    const callComplete = this.findMarkFrom("call_complete", cursor)?.at;
    if (requestSent != null && firstToken != null) {
      breakdown.ttftMs = firstToken - requestSent;
    }
    if (requestSent != null && callComplete != null) {
      breakdown.providerDurationMs = callComplete - requestSent;
    }
    // total-to-first-token is only meaningful for the first call of the turn,
    // the only segment that contains `turn_start`.
    if (cursor === 0 && firstToken != null) {
      const turnStart = this.findMarkFrom("turn_start", 0)?.at;
      if (turnStart != null) {
        breakdown.totalToFirstTokenMs = firstToken - turnStart;
      }
    }
    // Per-call kind, read off this segment's own `first_token` mark (a pure
    // tool-call response streams none, leaving it undefined).
    if (firstTokenMark?.kind) breakdown.firstTokenKind = firstTokenMark.kind;
    return { breakdown, cursor: end };
  }

  private findMarkFrom(
    name: string,
    from: number,
  ): { at: number; kind?: "thinking" | "text" } | undefined {
    for (let i = Math.max(from, 0); i < this.marks.length; i++) {
      if (this.marks[i]!.name === name) return this.marks[i]!;
    }
    return undefined;
  }
}
