/**
 * Persistence for the proactive tips feature.
 *
 * Per-tip state is a timestamp record (never booleans) so reshow thresholds
 * stay tunable later without a storage migration. All keys are device-scoped:
 * tips describe what this browser has already been told, not account state.
 */

import { createStorageAccessor, parseBool } from "@/utils/typed-storage";

export interface TipRecord {
  dismissedAt?: number;
  lastShownAt?: number;
  shownCount: number;
}

function isOptionalTimestamp(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function isValidTipRecord(value: unknown): value is TipRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.shownCount === "number" &&
    Number.isFinite(record.shownCount) &&
    isOptionalTimestamp(record.dismissedAt) &&
    isOptionalTimestamp(record.lastShownAt)
  );
}

function parseTipRecords(raw: string): Record<string, TipRecord> | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const result: Record<string, TipRecord> = {};
  for (const [tipId, value] of Object.entries(parsed)) {
    if (isValidTipRecord(value)) {
      result[tipId] = value;
    }
  }
  return result;
}

function parseTimestamp(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Per-tip timestamp records, keyed by tip id. */
export const tipRecordsStorage = createStorageAccessor<
  Record<string, TipRecord>
>({
  key: "device:tips:records",
  scope: "device",
  parse: parseTipRecords,
  serialize: JSON.stringify,
  fallback: {},
});

/** Master switch — the Settings "show tips" toggle writes here. */
export const tipsEnabledStorage = createStorageAccessor<boolean>({
  key: "device:tips:enabled",
  scope: "device",
  parse: parseBool,
  serialize: String,
  fallback: true,
});

/**
 * Dev/demo-only cycler chevron on the tip card. No UI writes this — enable
 * via console: `localStorage.setItem("device:tips:demo_cycler", "true")`.
 */
export const tipsDemoCyclerStorage = createStorageAccessor<boolean>({
  key: "device:tips:demo_cycler",
  scope: "device",
  parse: parseBool,
  serialize: String,
  fallback: false,
});

/** Where the tip surfaces: sidebar footer, composer banner slot, or nav popover. */
export type TipsPlacement = "sidebar" | "banner" | "popover";

/**
 * Experimental placement switcher. No UI writes this — set via console:
 * `localStorage.setItem("device:tips:placement", "banner")`.
 */
export const tipsPlacementStorage = createStorageAccessor<TipsPlacement>({
  key: "device:tips:placement",
  scope: "device",
  parse: (value) =>
    value === "sidebar" || value === "banner" || value === "popover"
      ? value
      : null,
  serialize: String,
  fallback: "sidebar",
});

/** Epoch ms of the first time the tips feature observed this user. 0 = not yet. */
export const tipsFirstSeenAtStorage = createStorageAccessor<number>({
  key: "device:tips:first_seen_at",
  scope: "device",
  parse: parseTimestamp,
  serialize: String,
  fallback: 0,
});

/** Stamp the first-seen timestamp once. Idempotent: later calls are no-ops. */
export function ensureTipsFirstSeenAt(): void {
  if (tipsFirstSeenAtStorage.load() === 0) {
    tipsFirstSeenAtStorage.save(Date.now());
  }
}

export function recordTipShown(tipId: string, now: number): void {
  const records = tipRecordsStorage.load();
  const existing = records[tipId];
  tipRecordsStorage.save({
    ...records,
    [tipId]: {
      ...existing,
      lastShownAt: now,
      shownCount: (existing?.shownCount ?? 0) + 1,
    },
  });
}

export function recordTipDismissed(tipId: string, now: number): void {
  const records = tipRecordsStorage.load();
  const existing = records[tipId];
  tipRecordsStorage.save({
    ...records,
    [tipId]: {
      ...existing,
      dismissedAt: now,
      shownCount: existing?.shownCount ?? 0,
    },
  });
}
