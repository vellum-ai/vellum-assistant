// Persist pinned-app state to localStorage so the SideMenu can show pinned
// apps across page reloads. This mirrors the macOS AppListManager.swift
// pattern: pin state is local-only, persisted to disk, survives daemon sync.
//
// Shape on disk: PinnedAppEntry[]

import type { AppSummary } from "@/domains/chat/lib/apps.js";

const STORAGE_KEY = "vellum:pinnedApps";

export interface PinnedAppEntry {
  appId: string;
  pinnedOrder: number;
  name: string;
  icon?: string;
}

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

function safeParse(raw: string | null): PinnedAppEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

export function loadPinnedApps(): PinnedAppEntry[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    return safeParse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function savePinnedApps(entries: PinnedAppEntry[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage can fail in private browsing / quota-exceeded cases. Silently
    // drop; in-memory state still works for the current session.
  }
}

export function pinApp(app: AppSummary): void {
  const entries = loadPinnedApps();
  if (entries.some((e) => e.appId === app.id)) {
    return;
  }
  const maxOrder = entries.reduce((max, e) => Math.max(max, e.pinnedOrder), 0);
  entries.push({
    appId: app.id,
    pinnedOrder: maxOrder + 1,
    name: app.name,
    icon: app.icon,
  });
  savePinnedApps(entries);
}

export function unpinApp(appId: string): void {
  let entries = loadPinnedApps().filter((e) => e.appId !== appId);
  // Re-compact pinnedOrder values so there are no gaps.
  entries = entries
    .sort((a, b) => a.pinnedOrder - b.pinnedOrder)
    .map((e, i) => ({ ...e, pinnedOrder: i + 1 }));
  savePinnedApps(entries);
}

export function isAppPinned(appId: string): boolean {
  return loadPinnedApps().some((e) => e.appId === appId);
}
