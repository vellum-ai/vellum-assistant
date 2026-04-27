/**
 * Sequence guardrails — safety checks that run before each send.
 *
 * Guardrails cause a send to be deferred (rescheduled for the next tick),
 * not permanently failed. The engine logs the reason so the assistant
 * can explain why a send was delayed.
 */

import { getLogger } from "../util/logger.js";
import { countActiveEnrollments, listEnrollments } from "./store.js";
import type { SequenceEnrollment } from "./types.js";

const log = getLogger("sequence:guardrails");

// ── Defaults ────────────────────────────────────────────────────────

export interface GuardrailConfig {
  dailySendCap: number;
  perSequenceHourlyRate: number;
  minimumStepDelaySec: number;
  maxActiveEnrollments: number;
  duplicateEnrollmentCheck: boolean;
  cooldownPeriodMs: number;
}

const DEFAULT_CONFIG: GuardrailConfig = {
  dailySendCap: 50,
  perSequenceHourlyRate: 10,
  minimumStepDelaySec: 60,
  maxActiveEnrollments: 200,
  duplicateEnrollmentCheck: true,
  cooldownPeriodMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

let config: GuardrailConfig = { ...DEFAULT_CONFIG };

export function getGuardrailConfig(): GuardrailConfig {
  return { ...config };
}

export function setGuardrailConfig(
  patch: Partial<GuardrailConfig>,
): GuardrailConfig {
  config = { ...config, ...patch };
  return { ...config };
}

// ── Send tracking (in-memory, resets on daemon restart) ─────────────

interface SendRecord {
  sequenceId: string;
  timestamp: number;
}

const sendLog: SendRecord[] = [];

export function recordSend(sequenceId: string): void {
  sendLog.push({ sequenceId, timestamp: Date.now() });
}

function getSendsToday(): number {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const cutoff = startOfDay.getTime();
  return sendLog.filter((r) => r.timestamp >= cutoff).length;
}

function getSendsThisHour(sequenceId: string): number {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return sendLog.filter(
    (r) => r.sequenceId === sequenceId && r.timestamp >= cutoff,
  ).length;
}

// ── Guardrail checks ────────────────────────────────────────────────

export type GuardrailResult =
  | { ok: true }
  | { ok: false; reason: string; guardrail: string };

function checkDailyCap(): GuardrailResult {
  const count = getSendsToday();
  if (count >= config.dailySendCap) {
    return {
      ok: false,
      reason: `Daily send cap reached (${count}/${config.dailySendCap}). Will retry tomorrow.`,
      guardrail: "daily_cap",
    };
  }
  return { ok: true };
}

function checkHourlyRate(sequenceId: string): GuardrailResult {
  const count = getSendsThisHour(sequenceId);
  if (count >= config.perSequenceHourlyRate) {
    return {
      ok: false,
      reason: `Hourly rate limit for sequence reached (${count}/${config.perSequenceHourlyRate}). Will retry next hour.`,
      guardrail: "hourly_rate",
    };
  }
  return { ok: true };
}

function checkMinDelay(delaySec: number): GuardrailResult {
  if (delaySec > 0 && delaySec < config.minimumStepDelaySec) {
    return {
      ok: false,
      reason: `Step delay (${delaySec}s) is below minimum (${config.minimumStepDelaySec}s).`,
      guardrail: "min_delay",
    };
  }
  return { ok: true };
}

export function checkEnrollmentCap(sequenceId: string): GuardrailResult {
  const count = countActiveEnrollments(sequenceId);
  if (count >= config.maxActiveEnrollments) {
    return {
      ok: false,
      reason: `Active enrollment cap reached (${count}/${config.maxActiveEnrollments}).`,
      guardrail: "enrollment_cap",
    };
  }
  return { ok: true };
}

export function checkDuplicateEnrollment(
  sequenceId: string,
  email: string,
  excludeEnrollmentId?: string,
): GuardrailResult {
  if (!config.duplicateEnrollmentCheck) return { ok: true };

  const existing = listEnrollments({
    sequenceId,
    contactEmail: email,
    status: "active",
  });
  const duplicates = excludeEnrollmentId
    ? existing.filter((e) => e.id !== excludeEnrollmentId)
    : existing;
  if (duplicates.length > 0) {
    return {
      ok: false,
      reason: `${email} is already enrolled in this sequence.`,
      guardrail: "duplicate",
    };
  }
  return { ok: true };
}

export function checkCooldown(
  sequenceId: string,
  email: string,
): GuardrailResult {
  if (config.cooldownPeriodMs <= 0) return { ok: true };

  const cutoff = Date.now() - config.cooldownPeriodMs;
  const past = listEnrollments({ sequenceId, contactEmail: email });
  const recent = past.filter(
    (e) =>
      (e.status === "completed" || e.status === "replied") &&
      e.updatedAt >= cutoff,
  );
  if (recent.length > 0) {
    const daysLeft = Math.ceil(
      (config.cooldownPeriodMs - (Date.now() - recent[0].updatedAt)) /
        (24 * 60 * 60 * 1000),
    );
    return {
      ok: false,
      reason: `${email} completed/replied to this sequence recently. Cooldown: ${daysLeft} day(s) remaining.`,
      guardrail: "cooldown",
    };
  }
  return { ok: true };
}

/**
 * Run all pre-send guardrails for an enrollment.
 * Returns the first failing check, or { ok: true } if all pass.
 */
export function checkAllPreSend(
  sequenceId: string,
  enrollment: SequenceEnrollment,
  stepDelaySec: number,
): GuardrailResult {
  const checks: GuardrailResult[] = [
    checkDailyCap(),
    checkHourlyRate(sequenceId),
    checkMinDelay(stepDelaySec),
    checkEnrollmentCap(sequenceId),
    checkDuplicateEnrollment(
      sequenceId,
      enrollment.contactEmail,
      enrollment.id,
    ),
    checkCooldown(sequenceId, enrollment.contactEmail),
  ];

  for (const check of checks) {
    if (!check.ok) {
      log.info(
        {
          enrollmentId: enrollment.id,
          guardrail: check.guardrail,
          reason: check.reason,
        },
        "Guardrail blocked send",
      );
      return check;
    }
  }

  return { ok: true };
}
