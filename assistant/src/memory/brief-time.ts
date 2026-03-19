/**
 * Deterministic compiler for the "Time-Relevant Context" section of the
 * memory brief.  Reads active `time_contexts` rows plus due-soon live
 * schedule jobs, sorts them by urgency bucket, and caps the output.
 */

import { and, gte, lte } from "drizzle-orm";

import { getDueSoonSchedules } from "../schedule/schedule-store.js";
import type { BriefEntry } from "./brief-formatting.js";
import { renderBriefSection } from "./brief-formatting.js";
import type { DrizzleDb } from "./db-connection.js";
import { timeContexts } from "./schema/memory-brief.js";

const MAX_ENTRIES = 3;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Urgency buckets — lower number = higher priority. */
const enum Bucket {
  HappeningNow = 0,
  Overdue = 1,
  Within24h = 2,
  Within7d = 3,
}

interface Candidate {
  bucket: Bucket;
  /** Epoch ms timestamp used for secondary sort within a bucket. */
  sortKey: number;
  entry: BriefEntry;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Compile the time-relevant brief section.
 *
 * @param db    Drizzle database instance
 * @param now   Current epoch-ms timestamp (injectable for deterministic tests)
 * @returns     Markdown string for the section, or `null` if nothing qualifies
 */
export function compileTimeBrief(
  db: DrizzleDb,
  scopeId: string,
  now: number,
): string | null {
  const candidates: Candidate[] = [];

  collectTimeContexts(db, scopeId, now, candidates);
  collectDueSoonSchedules(now, candidates);

  // Sort: primary = bucket ascending, secondary = sortKey ascending (sooner first)
  candidates.sort((a, b) => a.bucket - b.bucket || a.sortKey - b.sortKey);

  const entries = candidates.slice(0, MAX_ENTRIES).map((c) => c.entry);
  return renderBriefSection("Time-Relevant Context", entries, MAX_ENTRIES);
}

// ────────────────────────────────────────────────────────────────────
// Internal collectors
// ────────────────────────────────────────────────────────────────────

function collectTimeContexts(
  db: DrizzleDb,
  scopeId: string,
  now: number,
  out: Candidate[],
): void {
  // Active time contexts: activeFrom <= now AND activeUntil >= now
  const rows = db
    .select()
    .from(timeContexts)
    .where(
      and(
        lte(timeContexts.activeFrom, now),
        gte(timeContexts.activeUntil, now),
      ),
    )
    .all()
    .filter((r) => r.scopeId === scopeId);

  for (const row of rows) {
    const remaining = row.activeUntil - now;
    let bucket: Bucket;

    if (row.activeFrom <= now && row.activeUntil >= now) {
      // Currently active — classify by how much time remains
      if (remaining <= ONE_DAY_MS) {
        bucket = Bucket.HappeningNow;
      } else if (remaining <= SEVEN_DAYS_MS) {
        bucket = Bucket.Within24h;
      } else {
        bucket = Bucket.Within7d;
      }
    } else {
      bucket = Bucket.Within7d;
    }

    out.push({
      bucket,
      sortKey: row.activeUntil,
      entry: { text: row.summary },
    });
  }
}

function collectDueSoonSchedules(now: number, out: Candidate[]): void {
  const jobs = getDueSoonSchedules(now, SEVEN_DAYS_MS);

  for (const job of jobs) {
    const delta = job.nextRunAt - now;
    let bucket: Bucket;

    if (delta <= 0) {
      bucket = Bucket.Overdue;
    } else if (delta <= ONE_DAY_MS) {
      bucket = Bucket.Within24h;
    } else {
      bucket = Bucket.Within7d;
    }

    const label = formatScheduleLabel(job.name, job.nextRunAt, now);
    out.push({
      bucket,
      sortKey: job.nextRunAt,
      entry: { text: label },
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Formatting
// ────────────────────────────────────────────────────────────────────

function formatScheduleLabel(
  name: string,
  nextRunAt: number,
  now: number,
): string {
  const delta = nextRunAt - now;

  if (delta <= 0) {
    return `Scheduled: "${name}" — overdue`;
  }

  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) {
    return `Scheduled: "${name}" — in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) {
    return `Scheduled: "${name}" — in ${hours} hour${hours === 1 ? "" : "s"}`;
  }

  const days = Math.round(delta / 86_400_000);
  return `Scheduled: "${name}" — in ${days} day${days === 1 ? "" : "s"}`;
}
