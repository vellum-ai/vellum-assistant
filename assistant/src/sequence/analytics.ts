/**
 * Sequence analytics — tracks send events and computes metrics.
 *
 * Uses an in-memory event log (will be backed by sequence_events table
 * when the analytics migration is added). Provides per-sequence and
 * per-step metrics for dashboard rendering.
 */

import {
  countActiveEnrollments,
  listEnrollments,
  listSequences,
} from "./store.js";
import type { Sequence } from "./types.js";

// ── Event tracking ──────────────────────────────────────────────────

export type SequenceEventType =
  | "send"
  | "reply"
  | "complete"
  | "fail"
  | "cancel"
  | "pause"
  | "resume";

export interface SequenceEvent {
  id: string;
  sequenceId: string;
  enrollmentId: string;
  eventType: SequenceEventType;
  stepIndex?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

let eventCounter = 0;
const eventLog: SequenceEvent[] = [];

/** Hard cap to prevent unbounded memory growth. When exceeded, the oldest
 *  half of events is discarded. 10 000 events is enough for dashboard
 *  metrics while keeping memory usage predictable. */
const MAX_EVENT_LOG_SIZE = 10_000;

export function recordEvent(
  sequenceId: string,
  enrollmentId: string,
  eventType: SequenceEventType,
  stepIndex?: number,
  metadata?: Record<string, unknown>,
): SequenceEvent {
  const event: SequenceEvent = {
    id: `evt_${++eventCounter}`,
    sequenceId,
    enrollmentId,
    eventType,
    stepIndex,
    metadata,
    createdAt: Date.now(),
  };
  eventLog.push(event);

  // Evict the oldest half when the log exceeds the cap
  if (eventLog.length > MAX_EVENT_LOG_SIZE) {
    eventLog.splice(0, eventLog.length - Math.floor(MAX_EVENT_LOG_SIZE / 2));
  }

  return event;
}

function getRecentEvents(limit = 20): SequenceEvent[] {
  return eventLog.slice(-limit).reverse();
}

// ── Metrics ─────────────────────────────────────────────────────────

export interface SequenceMetrics {
  sequenceId: string;
  sequenceName: string;
  status: string;
  totalEnrollments: number;
  activeEnrollments: number;
  sends: number;
  replies: number;
  completions: number;
  failures: number;
  cancellations: number;
  replyRate: number;
  completionRate: number;
  avgTimeToReplyMs: number | null;
}

export interface StepMetrics {
  stepIndex: number;
  subject: string;
  sends: number;
  enrollmentsReached: number;
  dropOff: number;
}

export interface DashboardData {
  summary: {
    totalSequences: number;
    activeSequences: number;
    activeEnrollments: number;
    sendsToday: number;
    overallReplyRate: number;
  };
  sequences: SequenceMetrics[];
  recentEvents: SequenceEvent[];
}

function computeSequenceMetrics(seq: Sequence): SequenceMetrics {
  const enrollments = listEnrollments({ sequenceId: seq.id });
  const active = countActiveEnrollments(seq.id);

  const statusCounts = enrollments.reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const replies = statusCounts["replied"] ?? 0;
  const completions = statusCounts["completed"] ?? 0;
  const failures = statusCounts["failed"] ?? 0;
  const cancellations = statusCounts["cancelled"] ?? 0;

  const total = enrollments.length;
  const replyRate = total > 0 ? replies / total : 0;
  const completionRate = total > 0 ? completions / total : 0;

  // Compute average time to reply from event log
  const replyEvents = eventLog.filter(
    (e) => e.sequenceId === seq.id && e.eventType === "reply",
  );
  let avgTimeToReplyMs: number | null = null;
  if (replyEvents.length > 0) {
    const firstSendTimes = new Map<string, number>();
    for (const e of eventLog) {
      if (
        e.sequenceId === seq.id &&
        e.eventType === "send" &&
        e.stepIndex === 0
      ) {
        if (!firstSendTimes.has(e.enrollmentId)) {
          firstSendTimes.set(e.enrollmentId, e.createdAt);
        }
      }
    }
    let totalTime = 0;
    let count = 0;
    for (const re of replyEvents) {
      const sendTime = firstSendTimes.get(re.enrollmentId);
      if (sendTime) {
        totalTime += re.createdAt - sendTime;
        count++;
      }
    }
    if (count > 0) avgTimeToReplyMs = totalTime / count;
  }

  // Count sends from event log
  const sends = eventLog.filter(
    (e) => e.sequenceId === seq.id && e.eventType === "send",
  ).length;

  return {
    sequenceId: seq.id,
    sequenceName: seq.name,
    status: seq.status,
    totalEnrollments: total,
    activeEnrollments: active,
    sends,
    replies,
    completions,
    failures,
    cancellations,
    replyRate,
    completionRate,
    avgTimeToReplyMs,
  };
}

export function getStepMetrics(sequenceId: string): StepMetrics[] {
  const seq =
    listSequences({ status: "active" }).find((s) => s.id === sequenceId) ??
    listSequences().find((s) => s.id === sequenceId);
  if (!seq) return [];

  const enrollments = listEnrollments({ sequenceId });
  const sendEvents = eventLog.filter(
    (e) => e.sequenceId === sequenceId && e.eventType === "send",
  );

  return seq.steps.map((step) => {
    const sends = sendEvents.filter((e) => e.stepIndex === step.index).length;
    const reached = enrollments.filter(
      (e) => e.currentStep >= step.index,
    ).length;
    const prevReached =
      step.index === 0
        ? enrollments.length
        : enrollments.filter((e) => e.currentStep >= step.index - 1).length;
    const dropOff = prevReached > 0 ? 1 - reached / prevReached : 0;

    return {
      stepIndex: step.index,
      subject: step.subjectTemplate,
      sends,
      enrollmentsReached: reached,
      dropOff,
    };
  });
}

export function getDashboardData(): DashboardData {
  const seqs = listSequences();
  const activeSeqs = seqs.filter((s) => s.status === "active");

  const sequenceMetrics = seqs.map(computeSequenceMetrics);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const sendsToday = eventLog.filter(
    (e) => e.eventType === "send" && e.createdAt >= startOfDay.getTime(),
  ).length;

  const totalEnrollments = sequenceMetrics.reduce(
    (s, m) => s + m.totalEnrollments,
    0,
  );
  const totalReplies = sequenceMetrics.reduce((s, m) => s + m.replies, 0);
  const overallReplyRate =
    totalEnrollments > 0 ? totalReplies / totalEnrollments : 0;

  const totalActive = sequenceMetrics.reduce(
    (s, m) => s + m.activeEnrollments,
    0,
  );

  return {
    summary: {
      totalSequences: seqs.length,
      activeSequences: activeSeqs.length,
      activeEnrollments: totalActive,
      sendsToday,
      overallReplyRate,
    },
    sequences: sequenceMetrics,
    recentEvents: getRecentEvents(20),
  };
}
