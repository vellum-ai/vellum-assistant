import { getLogger } from "../util/logger.js";

const log = getLogger("tool-profiler");

export interface ToolStats {
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number;
}

export interface ToolProfilingSummary {
  toolCount: number;
  totalToolTimeMs: number;
  wallClockMs: number;
  tools: Record<string, ToolStats>;
  peakRssMb: number;
  rssDeltaMb: number;
}

/**
 * Accumulates per-tool timing and resource stats across a request. The
 * executor records each tool completion directly via `recordToolCompletion`;
 * the conversation agent loop calls `startRequest()` at the beginning of a turn
 * and `emitSummary()` at the end.
 */
export class ToolProfiler {
  private tools = new Map<string, ToolStats>();
  private requestStartMs = 0;
  private rssStartBytes = 0;
  private peakRssBytes = 0;

  startRequest(): void {
    this.tools.clear();
    this.requestStartMs = Date.now();
    const rss = process.memoryUsage().rss;
    this.rssStartBytes = rss;
    this.peakRssBytes = rss;
  }

  recordToolCompletion(
    toolName: string,
    durationMs: number,
    isError: boolean,
  ): void {
    let stats = this.tools.get(toolName);
    if (!stats) {
      stats = { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
      this.tools.set(toolName, stats);
    }
    stats.count++;
    stats.totalMs += durationMs;
    if (durationMs > stats.maxMs) {
      stats.maxMs = durationMs;
    }
    if (isError) {
      stats.errors++;
    }

    const currentRss = process.memoryUsage().rss;
    if (currentRss > this.peakRssBytes) {
      this.peakRssBytes = currentRss;
    }
  }

  getSummary(): ToolProfilingSummary {
    let totalToolTimeMs = 0;
    let toolCount = 0;
    const tools: Record<string, ToolStats> = {};

    for (const [name, stats] of this.tools) {
      tools[name] = { ...stats };
      totalToolTimeMs += stats.totalMs;
      toolCount += stats.count;
    }

    const peakRssMb = Math.round(this.peakRssBytes / 1024 / 1024);
    const rssDeltaMb = Math.round(
      (this.peakRssBytes - this.rssStartBytes) / 1024 / 1024,
    );

    return {
      toolCount,
      totalToolTimeMs,
      wallClockMs:
        this.requestStartMs > 0 ? Date.now() - this.requestStartMs : 0,
      tools,
      peakRssMb,
      rssDeltaMb,
    };
  }

  /** Release all accumulated stats. */
  clear(): void {
    this.tools.clear();
    this.requestStartMs = 0;
    this.rssStartBytes = 0;
    this.peakRssBytes = 0;
  }

  emitSummary(requestId?: string): void {
    const summary = this.getSummary();
    if (summary.toolCount === 0) {
      return;
    }

    // Find the slowest individual tool invocation
    let slowestTool = "";
    let slowestMs = 0;
    for (const [name, stats] of Object.entries(summary.tools)) {
      if (stats.maxMs > slowestMs) {
        slowestMs = stats.maxMs;
        slowestTool = name;
      }
    }

    log.info(
      {
        requestId,
        toolCount: summary.toolCount,
        totalToolTimeMs: summary.totalToolTimeMs,
        wallClockMs: summary.wallClockMs,
        peakRssMb: summary.peakRssMb,
        rssDeltaMb: summary.rssDeltaMb,
        slowestTool,
        slowestToolMaxMs: slowestMs,
        tools: summary.tools,
      },
      "Tool execution profiling summary",
    );
  }
}

// ---------------------------------------------------------------------------
// Conversation-keyed registry
//
// The profiler is per-conversation in-memory state, but its recording surface
// is a terminal like the audit/telemetry sinks: the executor imports
// `recordToolCompletion` directly and passes the conversation id, rather than
// receiving a profiler instance threaded through `ToolContext`. Turns within a
// conversation are serialized, so a single profiler per conversation is safe.
// ---------------------------------------------------------------------------

const profilersByConversation = new Map<string, ToolProfiler>();

/** Begin a fresh per-turn profiling window for a conversation. */
export function startToolProfilingRequest(conversationId: string): void {
  let profiler = profilersByConversation.get(conversationId);
  if (!profiler) {
    profiler = new ToolProfiler();
    profilersByConversation.set(conversationId, profiler);
  }
  profiler.startRequest();
}

/**
 * Record a completed tool invocation into the conversation's profiler.
 * A no-op when no profiling window is active (e.g. standalone tool runs).
 */
export function recordToolCompletion(
  conversationId: string,
  toolName: string,
  durationMs: number,
  isError: boolean,
): void {
  profilersByConversation
    .get(conversationId)
    ?.recordToolCompletion(toolName, durationMs, isError);
}

/** Emit the end-of-turn profiling summary log for a conversation. */
export function emitToolProfilingSummary(
  conversationId: string,
  requestId?: string,
): void {
  profilersByConversation.get(conversationId)?.emitSummary(requestId);
}

/** Drop a conversation's profiler. Called on conversation teardown. */
export function disposeToolProfiler(conversationId: string): void {
  profilersByConversation.delete(conversationId);
}
