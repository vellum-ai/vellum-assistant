/**
 * Bridge to the iOS shell's `WidgetSnapshot` plugin
 * (`clients/ios/App/App/WidgetSnapshotPlugin.swift`), which caches a small
 * summary of the conversation list in the App Group so the Home Screen
 * widgets can draw unread and in-progress counts plus the three most recent
 * chats without a network stack or auth of their own.
 * `useNativeWidgetSnapshotSync` is the one producer.
 *
 * iOS-only by design: only the iOS shell ships WidgetKit surfaces, so
 * pushing this cache anywhere else would be pure bridge traffic. Widen the
 * gate if another platform grows a home-screen surface.
 *
 * Nothing secret crosses the bridge. The snapshot carries conversation ids,
 * titles, group names and counts, never tokens, and the widget process reads
 * it without ever holding a session of its own.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";

/**
 * Which assistant produced the snapshot currently in the App Group.
 *
 * The cache outlives the page, so a cold launch inherits a snapshot no
 * in-memory ref can account for and has to be able to tell whether it belongs
 * to the assistant now active. Per-device UI bookkeeping rather than wire
 * state, so it lives in localStorage beside the client's other local
 * settings; a read or write that fails leaves it absent, which reads as "no
 * known producer" and preserves the last-known-good snapshot.
 */
const SNAPSHOT_ASSISTANT_ID_KEY = "vellum:widgetSnapshotAssistantId";

/** The assistant that wrote the snapshot in the App Group, if it is known. */
export function readWidgetSnapshotAssistantId(): string | null {
  return getLocalSetting(SNAPSHOT_ASSISTANT_ID_KEY, "") || null;
}

/**
 * An unfinished obligation to drop the native snapshot.
 *
 * A clear on a session seam cannot be made blocking: sign-out and an origin
 * swap have to proceed whether or not the bridge answers, so neither can be
 * held hostage to it. A clear that rejects or times out therefore records the
 * obligation here rather than dropping it, and the next use of this module
 * honors it before writing anything of its own. That makes a session-ending
 * clear at-least-once across launches instead of fire-and-forget, which is what
 * keeps a departed account's conversation titles off a Home Screen that never
 * reloads on its own.
 *
 * Persisted beside the producer id and just as best-effort: storage that
 * refuses the write leaves the marker absent, which reads as "nothing owed" and
 * falls back to the producer-id machinery, one belt for the other's braces.
 */
const PENDING_CLEAR_KEY = "vellum:widgetSnapshotPendingClear";

function hasPendingClear(): boolean {
  return getLocalSetting(PENDING_CLEAR_KEY, "") !== "";
}

/**
 * Bumped as every clear starts AND as it settles, so a write on the bridge
 * across any part of one can tell that it belongs to a session that is ending.
 * Such a write may land on either side of the clear, so what it leaves in the
 * App Group is itself something to clear rather than a snapshot the current
 * session wants.
 */
let clearGeneration = 0;

/** The retry in flight, so a mount-time retry and a sync share one clear. */
let pendingClearRetry: Promise<boolean> | null = null;

/**
 * Wire-format version. Must stay in lockstep with the Swift side's
 * `WidgetSnapshot.currentSchemaVersion`: a snapshot written under a version
 * the reader does not recognize is discarded rather than misread, which is
 * how a shell and a web bundle that disagree degrade to the empty state
 * instead of to garbled rows.
 */
export const WIDGET_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * One row as a widget draws it. No timestamp: the producer sends the rows in
 * the order they are meant to appear, so nothing on the Swift side has to sort
 * or date them, and a field no surface renders is bridge traffic and App Group
 * space for nothing.
 */
export interface WidgetSnapshotConversation {
  id: string;
  title: string;
  /** The conversation's group name; omitted when it is ungrouped. */
  subtitle?: string;
  hasUnseen: boolean;
  isProcessing: boolean;
}

export interface WidgetSnapshotPayload {
  schemaVersion: typeof WIDGET_SNAPSHOT_SCHEMA_VERSION;
  /** ISO 8601 UTC, stamped by the producer as the payload is built. */
  generatedAt: string;
  unreadCount: number;
  inProgressCount: number;
  /** The most recent non-archived conversations, newest first, at most three. */
  conversations: WidgetSnapshotConversation[];
}

interface WidgetSnapshotPlugin {
  sync(options: WidgetSnapshotPayload): Promise<{ ok: boolean }>;
  clear(): Promise<{ ok: boolean }>;
}

const WidgetSnapshot = registerPlugin<WidgetSnapshotPlugin>("WidgetSnapshot");

export function isWidgetSnapshotSyncAvailable(): boolean {
  return Capacitor.getPlatform() === "ios";
}

/**
 * How long a bridge call is given before the caller stops waiting on it.
 *
 * Both calls below are awaited on session-ending paths before the state write
 * that flips the app to its signed-out surfaces (`endSession` in
 * `stores/auth-store.ts`), and before an origin swap hands the shell to
 * another deployment. A bridge that accepts the call and never settles would
 * hang those, so the wait is bounded rather than open. Two seconds is far
 * longer than a UserDefaults write and a widget timeline reload take, and far
 * shorter than anyone waits on a sign-out.
 */
const BRIDGE_TIMEOUT_MS = 2_000;

/**
 * Run one bridge call, reporting whether it landed.
 *
 * A rejection is the expected older shell (see the skew convention in
 * `apns-environment.ts`), and a call that never settles is that same skew one
 * step further along: the plugin answered its registration but not the call.
 * Both degrade the same way, silently and to a debug log, because a caller on
 * a session seam has nothing better to do with either answer.
 */
async function callBridge(
  method: "sync" | "clear",
  call: () => Promise<unknown>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const landed = await Promise.race([
      call().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), BRIDGE_TIMEOUT_MS);
      }),
    ]);
    if (!landed) {
      console.debug(
        `[widget-snapshot] WidgetSnapshot.${method} did not answer in ${BRIDGE_TIMEOUT_MS}ms`,
      );
    }
    return landed;
  } catch (err) {
    console.debug("[widget-snapshot] WidgetSnapshot bridge unavailable:", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replace the native snapshot with `snapshot` (the caller owns membership,
 * ordering and the counts). Swallows a bridge that fails or never answers per
 * {@link callBridge}: an older installed shell without the plugin is an
 * expected state on every web deploy, not a fault.
 *
 * `assistantId` is the assistant the snapshot was built from, recorded once
 * the write lands so a later cold launch can recognize a snapshot it did not
 * produce. A sync that did not land leaves whatever the last successful one
 * wrote, and so leaves the recorded producer with it.
 *
 * Reports whether the write landed, without ever rejecting: the producer hook
 * dedupes on the payload it last sent, and a key armed for a write that was
 * rejected or timed out would suppress every retry until the conversation data
 * itself changed, leaving a stale snapshot on the Home Screen. False off iOS
 * too, where nothing was written by construction.
 *
 * An owed clear ({@link PENDING_CLEAR_KEY}) is honored first, so a snapshot a
 * previous session failed to drop is never left underneath a new one. The wait
 * is what makes the ordering real rather than merely intended: a clear issued
 * alongside this write could otherwise land after it and wipe the fresh
 * snapshot.
 *
 * A landed write then discharges that obligation, because the plugin REPLACES
 * the App Group record rather than merging into it: the payload the clear was
 * owed for no longer exists once this one is in. The equivalence is exact only
 * while the Swift side keeps replacing, so a plugin that ever merged would have
 * to break it.
 */
export async function syncWidgetSnapshot(
  snapshot: WidgetSnapshotPayload,
  assistantId: string | null,
): Promise<boolean> {
  if (!isWidgetSnapshotSyncAvailable()) {
    return false;
  }
  await retryPendingWidgetSnapshotClear();
  const generation = clearGeneration;
  if (!(await callBridge("sync", () => WidgetSnapshot.sync(snapshot)))) {
    return false;
  }
  if (generation !== clearGeneration) {
    // A clear started while this write was on the bridge, so the session it
    // describes is over and what it left is owed a clear of its own. Re-arming
    // rather than discharging is also what covers the clear that SUCCEEDED
    // before this landed: the record it removed cannot name this orphan, so the
    // marker is the only thing left that can reach it.
    setLocalSetting(PENDING_CLEAR_KEY, "1");
    return true;
  }
  removeLocalSetting(PENDING_CLEAR_KEY);
  if (assistantId === null) {
    removeLocalSetting(SNAPSHOT_ASSISTANT_ID_KEY);
    return true;
  }
  setLocalSetting(SNAPSHOT_ASSISTANT_ID_KEY, assistantId);
  return true;
}

/**
 * Drop the native snapshot, leaving the widgets on their empty state.
 *
 * Called when a session ends. A Home Screen widget is readable without
 * unlocking the app, so the previous account's conversation titles must not
 * outlive the session that produced them.
 *
 * Gated and guarded like {@link syncWidgetSnapshot}, because its callers are
 * platform-neutral session seams rather than the iOS-only producer hook.
 *
 * Drops the recorded producer with the snapshot, so every caller (sign-out,
 * assistant switch, an origin swap, the producer hook) leaves the two
 * consistent. The origin swap is the one that cannot be caught later: the
 * producer id lives in localStorage, which is per-origin, so the new
 * deployment starts with no record of the snapshot the old one left behind.
 *
 * Reports whether the native clear landed. A clear that did NOT land leaves the
 * App Group untouched, so it also leaves the recorded producer with it, and
 * records the obligation in {@link PENDING_CLEAR_KEY} for the next use of this
 * module to finish. Callers on a session seam are free to carry on either way,
 * which is the point of persisting the obligation rather than reporting it and
 * hoping: sign-out must not be blockable by a bridge, and the marker is what
 * keeps the clear at-least-once anyway. True off iOS, where there is nothing to
 * clear by construction.
 */
export async function clearWidgetSnapshot(): Promise<boolean> {
  if (!isWidgetSnapshotSyncAvailable()) {
    return true;
  }
  clearGeneration += 1;
  // Armed BEFORE the attempt, so a page torn down mid-call (a sign-out that
  // ends in a hard navigation, an origin swap, the user closing the app) still
  // leaves the obligation behind rather than losing it with the page.
  setLocalSetting(PENDING_CLEAR_KEY, "1");
  const landed = await callBridge("clear", () => WidgetSnapshot.clear());
  // Bumped again as the call settles, not only as it starts. A write that
  // entered after the start and lands after the finish overlapped this call
  // from end to end, and one bump cannot tell that apart from no overlap:
  // the write would read the same generation it captured and take itself for
  // uncontested.
  clearGeneration += 1;
  if (!landed) {
    return false;
  }
  removeLocalSetting(SNAPSHOT_ASSISTANT_ID_KEY);
  removeLocalSetting(PENDING_CLEAR_KEY);
  return true;
}

/**
 * Finish a clear a previous attempt owed, if one is owed.
 *
 * {@link syncWidgetSnapshot} awaits this itself, so no write can slip past an
 * owed clear. The producer hook also calls it on mount, for the launch that
 * never syncs at all: a list that stays unresolved (offline, an assistant that
 * never comes up) reaches no other seam, and the obligation would otherwise
 * wait for a session that does.
 *
 * Concurrent callers share the one in-flight clear rather than each issuing
 * their own, so a retry cannot land after a sync that was waiting on it and
 * wipe the snapshot that sync just wrote.
 *
 * Resolves true when nothing is owed, which includes off iOS.
 */
export async function retryPendingWidgetSnapshotClear(): Promise<boolean> {
  if (!isWidgetSnapshotSyncAvailable() || !hasPendingClear()) {
    return true;
  }
  if (pendingClearRetry === null) {
    pendingClearRetry = clearWidgetSnapshot().finally(() => {
      pendingClearRetry = null;
    });
  }
  return pendingClearRetry;
}
