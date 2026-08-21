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
 */
export async function syncWidgetSnapshot(
  snapshot: WidgetSnapshotPayload,
  assistantId: string | null,
): Promise<void> {
  if (!isWidgetSnapshotSyncAvailable()) {
    return;
  }
  if (!(await callBridge("sync", () => WidgetSnapshot.sync(snapshot)))) {
    return;
  }
  if (assistantId === null) {
    removeLocalSetting(SNAPSHOT_ASSISTANT_ID_KEY);
    return;
  }
  setLocalSetting(SNAPSHOT_ASSISTANT_ID_KEY, assistantId);
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
 */
export async function clearWidgetSnapshot(): Promise<void> {
  if (!isWidgetSnapshotSyncAvailable()) {
    return;
  }
  if (!(await callBridge("clear", () => WidgetSnapshot.clear()))) {
    return;
  }
  removeLocalSetting(SNAPSHOT_ASSISTANT_ID_KEY);
}
