import { createHash } from "node:crypto";

import { getConfig } from "../config/loader.js";
import { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import { computeNextRunAt } from "../schedule/recurrence-engine.js";
import { listSchedules, type ScheduleJob } from "../schedule/schedule-store.js";

export type BackgroundWakeIntentReason = "heartbeat" | "schedule" | "mixed";

export interface BackgroundWakeSourcePayload {
  heartbeat: HeartbeatWakeSource | null;
  schedules: ScheduleWakeSource[];
}

export interface BackgroundWakeIntent {
  nextWakeAt: number;
  actualNextDueAt: number;
  reason: BackgroundWakeIntentReason;
  sourceGeneration: string;
  computedAt: number;
  sourcePayload: BackgroundWakeSourcePayload;
}

interface HeartbeatWakeSource {
  nextRunAt: number;
  mode: "cron" | "interval";
  intervalMs: number;
  cronExpression: string | null;
  timezone: string | null;
  activeHoursStart: number | null;
  activeHoursEnd: number | null;
  maxConsecutiveRuns: number | null;
}

interface ScheduleWakeSource {
  id: string;
  nextRunAt: number;
  mode: ScheduleJob["mode"];
  createdBy: string;
  status: ScheduleJob["status"];
  updatedAt: number;
}

type WakeCandidate = {
  nextRunAt: number;
  source: "heartbeat" | "schedule";
};

export function computeNextBackgroundWakeIntent(
  now = Date.now(),
): BackgroundWakeIntent | null {
  const heartbeat = getHeartbeatWakeSource(now);
  const schedules = getScheduleWakeSources();
  const computedAt = Date.now();
  const candidates: WakeCandidate[] = [];

  if (heartbeat) {
    candidates.push({ nextRunAt: heartbeat.nextRunAt, source: "heartbeat" });
  }
  for (const schedule of schedules) {
    candidates.push({ nextRunAt: schedule.nextRunAt, source: "schedule" });
  }

  if (candidates.length === 0) return null;

  const actualNextDueAt = Math.min(...candidates.map((c) => c.nextRunAt));
  const nextWakeAt = actualNextDueAt;
  const dueSources = new Set(
    candidates
      .filter((candidate) => candidate.nextRunAt === actualNextDueAt)
      .map((candidate) => candidate.source),
  );
  const reason =
    dueSources.size > 1
      ? "mixed"
      : dueSources.has("heartbeat")
        ? "heartbeat"
        : "schedule";
  const sourcePayload = { heartbeat, schedules };

  return {
    nextWakeAt,
    actualNextDueAt,
    reason,
    sourceGeneration: computeSourceGeneration({
      actualNextDueAt,
      sourcePayload,
    }),
    computedAt,
    sourcePayload,
  };
}

function getHeartbeatWakeSource(now: number): HeartbeatWakeSource | null {
  const config = getConfig().heartbeat;
  if (!config.enabled) return null;

  const service = HeartbeatService.getInstance();
  if (service?.isConsecutiveRunCapReached) return null;
  if (service?.isDailyCapReached) return null;

  const serviceNextRunAt = service?.nextRunAt ?? null;
  let nextRunAt = serviceNextRunAt;
  const mode = config.cronExpression != null ? "cron" : "interval";

  if (nextRunAt == null) {
    if (config.cronExpression != null) {
      try {
        nextRunAt = computeNextRunAt(
          {
            syntax: "cron",
            expression: config.cronExpression,
            timezone: config.timezone,
          },
          now,
        );
      } catch {
        nextRunAt = now + config.intervalMs;
      }
    } else {
      nextRunAt = now + config.intervalMs;
    }
  }

  if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) return null;

  return {
    nextRunAt,
    mode,
    intervalMs: config.intervalMs,
    cronExpression: config.cronExpression,
    timezone: config.timezone,
    activeHoursStart: config.activeHoursStart,
    activeHoursEnd: config.activeHoursEnd,
    maxConsecutiveRuns: config.maxConsecutiveRuns,
  };
}

function getScheduleWakeSources(): ScheduleWakeSource[] {
  return listSchedules({ enabledOnly: true })
    .filter((schedule) => schedule.status === "active")
    .filter((schedule) => Number.isFinite(schedule.nextRunAt))
    .filter((schedule) => schedule.nextRunAt > 0)
    .sort((a, b) => a.nextRunAt - b.nextRunAt || a.id.localeCompare(b.id))
    .map((schedule) => ({
      id: schedule.id,
      nextRunAt: schedule.nextRunAt,
      mode: schedule.mode,
      createdBy: schedule.createdBy,
      status: schedule.status,
      updatedAt: schedule.updatedAt,
    }));
}

function computeSourceGeneration(input: {
  actualNextDueAt: number;
  sourcePayload: BackgroundWakeSourcePayload;
}): string {
  return `bw1:${createHash("sha256")
    .update(stableStringify(input))
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
