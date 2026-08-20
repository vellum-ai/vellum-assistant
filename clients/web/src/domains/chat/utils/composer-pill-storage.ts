// Persist the labels the composer's settings pills last displayed, per
// assistant, so a relaunch paints both of them in the first frame.
//
// The two pills are fed by fetches that land far apart on a cold boot: the
// access preset comes from the gateway's own store (fast) while the model
// profile comes from the daemon-proxied config (slow). The row therefore
// assembles itself in visible steps, and the access pill has to stay hidden
// until its fetch settles because the un-fetched fallback preset names a
// stricter level than the server's real default.
//
// This is a deliberate, narrow exception to "server data has one owner: its
// query cache" (see clients/web/AGENTS.md). The snapshot is display-only: it
// names what the pills render before their queries settle, never what a
// selection writes back, and the live query values still gate every mutation.
// Same rationale as `context-window-storage.ts`: the desktop client keeps this
// state alive in a long-lived view model, and a browser tab (or a WKWebView
// that was evicted) has to rebuild it from storage instead.
//
// Keys are `vellum:`-prefixed and therefore user-scoped: the logout sweep in
// `lib/auth/session-cleanup.ts` removes them. One value per assistant rather
// than a per-conversation map, so there is nothing to trim.

import { useMemo } from "react";

import { createKeyedStorageAccessor } from "@/utils/typed-storage";

export interface ComposerPillSnapshot {
  /** `ThresholdPreset.id` the access pill last displayed. */
  accessPresetId: string | null;
  /** Display label the model-profile pill last displayed. */
  profileLabel: string | null;
}

const EMPTY: ComposerPillSnapshot = {
  accessPresetId: null,
  profileLabel: null,
};

function parseSnapshot(raw: string): ComposerPillSnapshot | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const accessPresetId =
    typeof record.accessPresetId === "string" ? record.accessPresetId : null;
  const profileLabel =
    typeof record.profileLabel === "string" ? record.profileLabel : null;
  if (accessPresetId === null && profileLabel === null) {
    return null;
  }
  return { accessPresetId, profileLabel };
}

const storage = createKeyedStorageAccessor<ComposerPillSnapshot>({
  keyFn: (assistantId) => `vellum:composerPills:${assistantId}`,
  scope: "user",
  parse: parseSnapshot,
  serialize: JSON.stringify,
  fallback: EMPTY,
});

/**
 * Read one assistant's snapshot during render, so the first paint already
 * carries the stored labels.
 *
 * Deliberately unsubscribed, unlike the accessor's own `useValue`: the snapshot
 * is a boot seed, spent the moment the fetches it stands in for settle. A
 * subscription would re-render every consumer on its own write-back, and would
 * let a value written after the pill resolved replace a label the user is
 * already reading.
 */
export function useComposerPillSnapshot(
  assistantId: string,
): ComposerPillSnapshot {
  return useMemo(() => storage.load(assistantId), [assistantId]);
}

export function loadComposerPillSnapshot(
  assistantId: string,
): ComposerPillSnapshot {
  return storage.load(assistantId);
}

export function saveComposerPillAccessPreset(
  assistantId: string,
  accessPresetId: string,
): void {
  const current = storage.load(assistantId);
  if (current.accessPresetId === accessPresetId) {
    return;
  }
  storage.save(assistantId, { ...current, accessPresetId });
}

/**
 * Drop the stored access preset while leaving the profile label alone. For
 * when the server's answer invalidates the seed without supplying a
 * replacement this build can name.
 */
export function clearComposerPillAccessPreset(assistantId: string): void {
  const current = storage.load(assistantId);
  if (current.accessPresetId === null) {
    return;
  }
  storage.save(assistantId, { ...current, accessPresetId: null });
}

/** {@link clearComposerPillAccessPreset}'s counterpart for the profile pill. */
export function clearComposerPillProfileLabel(assistantId: string): void {
  const current = storage.load(assistantId);
  if (current.profileLabel === null) {
    return;
  }
  storage.save(assistantId, { ...current, profileLabel: null });
}

export function saveComposerPillProfileLabel(
  assistantId: string,
  profileLabel: string,
): void {
  const current = storage.load(assistantId);
  if (current.profileLabel === profileLabel) {
    return;
  }
  storage.save(assistantId, { ...current, profileLabel });
}
