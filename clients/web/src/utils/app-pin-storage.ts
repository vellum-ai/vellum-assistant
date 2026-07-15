// Persist pinned-app state to localStorage so the SideMenu can show pinned
// apps across page reloads. This mirrors the macOS AppListManager.swift
// pattern: pin state is local-only, persisted to disk, survives daemon sync.

import type { AppSummary } from "@/types/app-types";
import { createStorageAccessor } from "@/utils/typed-storage";

export interface PinnedAppEntry {
  appId: string;
  pinnedOrder: number;
  name: string;
  icon?: string;
}

/**
 * The subset of {@link AppSummary} the pin store reads. Pinning persists only
 * the identity and display fields, so callers need not supply server-derived
 * metadata (`version`, `contentId`, timestamps, `origin`) just to pin.
 */
export type PinnableApp = Pick<AppSummary, "id" | "name" | "icon">;

function isValidEntry(value: unknown): value is PinnedAppEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.appId === "string" &&
    typeof record.pinnedOrder === "number" &&
    Number.isFinite(record.pinnedOrder) &&
    typeof record.name === "string" &&
    (record.icon === undefined || typeof record.icon === "string")
  );
}

function parsePinnedApps(raw: string): PinnedAppEntry[] | null {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.filter(isValidEntry);
}

const storage = createStorageAccessor<PinnedAppEntry[]>({
  key: "vellum:pinnedApps",
  scope: "user",
  parse: parsePinnedApps,
  serialize: JSON.stringify,
  fallback: [],
});

export const loadPinnedApps = storage.load;
export const savePinnedApps = storage.save;

export function pinApp(app: PinnableApp): void {
  const entries = storage.load();
  if (entries.some((e) => e.appId === app.id)) {
    return;
  }
  const maxOrder = entries.reduce((max, e) => Math.max(max, e.pinnedOrder), 0);
  storage.save([
    ...entries,
    {
      appId: app.id,
      pinnedOrder: maxOrder + 1,
      name: app.name,
      icon: app.icon,
    },
  ]);
}

export function unpinApp(appId: string): void {
  let entries = storage.load().filter((e) => e.appId !== appId);
  entries = entries
    .sort((a, b) => a.pinnedOrder - b.pinnedOrder)
    .map((e, i) => ({ ...e, pinnedOrder: i + 1 }));
  storage.save(entries);
}

export function isAppPinned(appId: string): boolean {
  return storage.load().some((e) => e.appId === appId);
}
