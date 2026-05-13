import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_repair_memory_graph_event_dates_v1";
const REPAIR_CREATED_YEAR = 2026;
const CORRUPT_EVENT_YEARS = [2024, 2025] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CORRECTED_DISTANCE_MS = 120 * DAY_MS;

interface GraphNodeEventDateRow {
  id: string;
  created: number;
  event_date: number;
  content: string;
}

interface EventDateRepair {
  id: string;
  oldEventDate: number;
  newEventDate: number;
}

function utcYear(epochMs: number): number {
  return new Date(epochMs).getUTCFullYear();
}

function replaceUtcYear(epochMs: number, year: number): number {
  const date = new Date(epochMs);
  return Date.UTC(
    year,
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
}

function contentMentionsYear(content: string, year: number): boolean {
  return new RegExp(`\\b${year}\\b`).test(content);
}

export function repairMemoryGraphEventDate(
  createdMs: number,
  eventDateMs: number,
  content: string,
): number | null {
  if (!Number.isFinite(createdMs) || !Number.isFinite(eventDateMs)) {
    return null;
  }

  const createdYear = utcYear(createdMs);
  const eventYear = utcYear(eventDateMs);
  if (createdYear !== REPAIR_CREATED_YEAR) return null;
  if (!CORRUPT_EVENT_YEARS.includes(eventYear as 2024 | 2025)) return null;

  // If the memory's prose explicitly mentions the prior year, the date is
  // user-anchored history — not the partial-date inference bug — so leave it.
  if (contentMentionsYear(content, eventYear)) return null;

  const corrected = replaceUtcYear(eventDateMs, createdYear);
  if (corrected === eventDateMs) return null;

  // This targets the observed extractor failure: a recent or near-future
  // month/day was anchored to a prior year. Leave distant historical dates
  // alone even if they are in 2024/2025.
  if (Math.abs(corrected - createdMs) > MAX_CORRECTED_DISTANCE_MS) {
    return null;
  }

  return corrected;
}

export function migrate231RepairMemoryGraphEventDates(
  database: DrizzleDb,
): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);
    const rows = raw
      .query(
        /*sql*/ `
          SELECT id, created, event_date, content
          FROM memory_graph_nodes
          WHERE event_date IS NOT NULL
            AND CAST(strftime('%Y', created / 1000, 'unixepoch') AS INTEGER) = ?
            AND CAST(strftime('%Y', event_date / 1000, 'unixepoch') AS INTEGER) IN (?, ?)
        `,
      )
      .all(
        REPAIR_CREATED_YEAR,
        ...CORRUPT_EVENT_YEARS,
      ) as GraphNodeEventDateRow[];

    const repairs: EventDateRepair[] = [];
    for (const row of rows) {
      const corrected = repairMemoryGraphEventDate(
        row.created,
        row.event_date,
        row.content ?? "",
      );
      if (corrected == null) continue;
      repairs.push({
        id: row.id,
        oldEventDate: row.event_date,
        newEventDate: corrected,
      });
    }

    if (repairs.length === 0) return;

    const updateNode = raw.prepare(/*sql*/ `
        UPDATE memory_graph_nodes
        SET event_date = ?
        WHERE id = ?
          AND event_date = ?
      `);
    const updateTrigger = raw.prepare(/*sql*/ `
        UPDATE memory_graph_triggers
        SET event_date = ?
        WHERE node_id = ?
          AND event_date = ?
      `);

    raw.exec("BEGIN");
    try {
      for (const repair of repairs) {
        updateNode.run(repair.newEventDate, repair.id, repair.oldEventDate);
        updateTrigger.run(repair.newEventDate, repair.id, repair.oldEventDate);
      }
      raw.exec("COMMIT");
    } catch (error) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        // No active transaction.
      }
      throw error;
    }
  });
}
