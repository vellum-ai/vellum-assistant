/**
 * Formatting utilities shared by the Logs and Usage tabs. Mirrors the
 * formatting behavior of the macOS LogsAndUsagePanel so numbers render the
 * same across platforms.
 */

import {
  ArrowRight,
  Brain,
  Circle,
  CircleAlert,
  CircleCheck,
  CirclePlay,
  CircleX,
  Eye,
  Inbox,
  LockOpen,
  MessageCircle,
  RefreshCw,
  Shield,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type {
  TraceEventKind,
  TraceEventRow,
  TraceEventStatus,
} from "@/lib/trace-events/types.js";
import type {
  UsageGranularity,
  UsageTimeRange,
} from "@/lib/usage/types.js";

/** Format an epoch-millisecond timestamp as a locale-aware absolute time. */
export function formatTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    return "";
  }
  const d = new Date(timestampMs);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Format a short time-of-day for timeline event rows, matching the macOS
 * TraceRowView format (HH:MM:SS.mmm).
 */
export function formatTimelineTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    return "";
  }
  const d = new Date(timestampMs);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Format an integer token count with grouping separators. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) {
    return "0";
  }
  return Math.round(count).toLocaleString();
}

/**
 * Format the combined input+output token total for the session metrics card.
 * Mirrors the macOS `formatTokens(input:output:)` helper: totals >= 1000 are
 * shown as a one-decimal "Xk" abbreviation, smaller totals render as-is.
 */
export function formatTokensCombined(input: number, output: number): string {
  const total = (input ?? 0) + (output ?? 0);
  if (total >= 1000) {
    return `${(total / 1000).toFixed(1)}k`;
  }
  return total.toLocaleString();
}

/**
 * Format an LLM call latency in milliseconds. Mirrors the macOS
 * `formatLatency` helper: non-positive values render as "--", values over one
 * second use seconds with one decimal, otherwise whole milliseconds.
 */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "--";
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

/**
 * Format a USD cost. Very small costs (< $0.01) show up to six decimals so
 * the user still sees a non-zero value for a handful of tokens.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) {
    return "$0.00";
  }
  return `$${usd.toFixed(2)}`;
}

const RANGE_START_DAY_OFFSETS: Record<Exclude<UsageTimeRange, "all">, number> =
  {
    today: 0,
    "7d": 6,
    "30d": 29,
    "90d": 89,
  };

/** Convert a `UsageTimeRange` into a `{from, to}` epoch-millisecond pair. */
export function resolveRangeWindow(
  range: UsageTimeRange,
  now: Date | number = Date.now(),
): {
  from: number;
  to: number;
} {
  const to = typeof now === "number" ? now : now.getTime();
  if (range === "all") {
    return { from: 0, to };
  }
  const localNow = new Date(to);
  const dayOffset = RANGE_START_DAY_OFFSETS[range];
  const from = new Date(
    localNow.getFullYear(),
    localNow.getMonth(),
    localNow.getDate() - dayOffset,
  ).getTime();
  return { from, to };
}

export function resolveUsageGranularity(
  range: UsageTimeRange,
): UsageGranularity {
  return range === "today" ? "hourly" : "daily";
}

/**
 * Terminal status for a request group, mirroring
 * `TraceStore.RequestGroupStatus` in the macOS client.
 */
export type RequestGroupStatus =
  | "active"
  | "completed"
  | "cancelled"
  | "handedOff"
  | "error";

/**
 * Aggregate per-conversation metrics derived from trace events, mirroring
 * `TraceStore.ConversationMetrics` in the macOS client.
 */
export interface ConversationMetrics {
  requestCount: number;
  llmCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  averageLlmLatencyMs: number;
  toolFailureCount: number;
}

export const EMPTY_METRICS: ConversationMetrics = {
  requestCount: 0,
  llmCallCount: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  averageLlmLatencyMs: 0,
  toolFailureCount: 0,
};

function readNumberAttribute(
  event: TraceEventRow,
  key: string,
): number | undefined {
  const value = event.attributes?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Compute aggregate metrics from a flat list of trace events. Mirrors
 * `TraceStore.computeMetrics` in the macOS client.
 */
export function calculateMetrics(
  events: readonly TraceEventRow[],
): ConversationMetrics {
  if (events.length === 0) {
    return EMPTY_METRICS;
  }

  const requestIds = new Set<string>();
  let llmCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let toolFailureCount = 0;

  for (const event of events) {
    if (event.requestId) {
      requestIds.add(event.requestId);
    }
    switch (event.kind) {
      case "llm_call_finished": {
        llmCallCount += 1;
        totalInputTokens += readNumberAttribute(event, "inputTokens") ?? 0;
        totalOutputTokens += readNumberAttribute(event, "outputTokens") ?? 0;
        const latency = readNumberAttribute(event, "latencyMs");
        if (latency !== undefined) {
          latencySum += latency;
          latencyCount += 1;
        }
        break;
      }
      case "tool_failed":
        toolFailureCount += 1;
        break;
      default:
        break;
    }
  }

  return {
    requestCount: requestIds.size,
    llmCallCount,
    totalInputTokens,
    totalOutputTokens,
    averageLlmLatencyMs: latencyCount > 0 ? latencySum / latencyCount : 0,
    toolFailureCount,
  };
}

/**
 * Determine the terminal status of a request group by inspecting its events.
 * Mirrors `TraceStore.requestGroupStatus` in the macOS client.
 */
export function determineGroupStatus(
  events: readonly TraceEventRow[],
): RequestGroupStatus {
  for (const event of events) {
    switch (event.kind) {
      case "generation_cancelled":
        return "cancelled";
      case "generation_handoff":
        return "handedOff";
      case "request_error":
        return "error";
      case "message_complete":
        return "completed";
      default:
        break;
    }
  }
  if (events.some((e) => e.status === "error")) {
    return "error";
  }
  return "active";
}

interface EventGroup {
  requestId: string;
  firstSequence: number;
  events: TraceEventRow[];
}

/**
 * Group trace events by `requestId` (events with no request id are bucketed
 * under the empty string "System" group). Groups are sorted by the sequence
 * of their first event, matching `TraceTimelineView.groupedEvents` in the
 * macOS client.
 */
export function groupEventsByRequest(
  events: readonly TraceEventRow[],
): EventGroup[] {
  const byRequest = new Map<string, EventGroup>();
  for (const event of events) {
    const key = event.requestId ?? "";
    const existing = byRequest.get(key);
    if (existing) {
      existing.events.push(event);
      if (event.sequence < existing.firstSequence) {
        existing.firstSequence = event.sequence;
      }
    } else {
      byRequest.set(key, {
        requestId: key,
        firstSequence: event.sequence,
        events: [event],
      });
    }
  }
  for (const group of byRequest.values()) {
    group.events.sort((a, b) => a.sequence - b.sequence);
  }
  return [...byRequest.values()].sort(
    (a, b) => a.firstSequence - b.firstSequence,
  );
}

/**
 * Map a trace event kind to a lucide icon. Mirrors the `iconToken` switch in
 * `TraceRowView` on macOS.
 */
export function getIconForKind(kind: TraceEventKind): LucideIcon {
  switch (kind) {
    case "request_received":
      return CirclePlay;
    case "request_queued":
    case "request_dequeued":
      return Inbox;
    case "llm_call_started":
    case "llm_call_finished":
      return Brain;
    case "assistant_message":
      return MessageCircle;
    case "tool_started":
    case "tool_finished":
      return Wrench;
    case "tool_permission_requested":
      return Shield;
    case "tool_permission_decided":
      return LockOpen;
    case "tool_failed":
      return TriangleAlert;
    case "secret_detected":
      return Eye;
    case "generation_handoff":
      return RefreshCw;
    case "message_complete":
      return CircleCheck;
    case "generation_cancelled":
      return CircleX;
    case "request_error":
      return CircleAlert;
    default:
      return Circle;
  }
}

/**
 * Map an event status to a CSS color variable. Mirrors `TraceRowView.statusColor`.
 */
export function getStatusColor(status: TraceEventStatus | undefined): string {
  switch (status) {
    case "error":
      return "var(--system-negative-strong)";
    case "warning":
      return "var(--system-mid-strong)";
    case "success":
      return "var(--system-positive-strong)";
    case "info":
    default:
      return "var(--content-tertiary)";
  }
}

/** Icon + color for a request group header, mirroring `groupStatus*` helpers. */
export function getGroupStatusMeta(
  status: RequestGroupStatus,
): { Icon: LucideIcon; color: string } {
  switch (status) {
    case "active":
      return { Icon: ArrowRight, color: "var(--system-positive-strong)" };
    case "completed":
      return { Icon: CircleCheck, color: "var(--system-positive-strong)" };
    case "cancelled":
      return { Icon: CircleX, color: "var(--system-mid-strong)" };
    case "handedOff":
      return { Icon: RefreshCw, color: "var(--system-positive-strong)" };
    case "error":
      return { Icon: TriangleAlert, color: "var(--system-negative-strong)" };
  }
}

/** Render an attribute value into a human-readable string. */
export function stringifyAttributeValue(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}
