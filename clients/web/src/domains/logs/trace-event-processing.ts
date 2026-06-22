import {
  ArrowRight,
  Brain,
  Circle,
  CircleAlert,
  CircleCheck,
  CirclePlay,
  CircleX,
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
} from "./trace-events-api";

export type RequestGroupStatus =
  | "active"
  | "completed"
  | "cancelled"
  | "handedOff"
  | "error";

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

export interface EventGroup {
  requestId: string;
  firstSequence: number;
  events: TraceEventRow[];
}

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

export function getGroupStatusMeta(status: RequestGroupStatus): {
  Icon: LucideIcon;
  color: string;
} {
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

export function stringifyAttributeValue(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) {
    return "\u2014";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}
