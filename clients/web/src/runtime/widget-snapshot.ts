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

export interface WidgetSnapshotConversation {
  id: string;
  title: string;
  /** The conversation's group name; omitted when it is ungrouped. */
  subtitle?: string;
  /** ISO 8601 UTC; omitted when the conversation has no timestamp yet. */
  lastMessageAt?: string;
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
 * Replace the native snapshot with `snapshot` (the caller owns membership,
 * ordering and the counts). Swallows bridge failures with a debug log per
 * the skew convention (see `apns-environment.ts`): an older installed shell
 * without the plugin is an expected state on every web deploy, not a fault.
 *
 * `assistantId` is the assistant the snapshot was built from, recorded once
 * the write lands so a later cold launch can recognize a snapshot it did not
 * produce. A rejected sync leaves whatever the last successful one wrote, and
 * so leaves the recorded producer with it.
 */
export async function syncWidgetSnapshot(
  snapshot: WidgetSnapshotPayload,
  assistantId: string | null,
): Promise<void> {
  if (!isWidgetSnapshotSyncAvailable()) {
    return;
  }
  try {
    await WidgetSnapshot.sync(snapshot);
  } catch (err) {
    console.debug("[widget-snapshot] WidgetSnapshot bridge unavailable:", err);
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
 * assistant switch, the producer hook) leaves the two consistent.
 */
export async function clearWidgetSnapshot(): Promise<void> {
  if (!isWidgetSnapshotSyncAvailable()) {
    return;
  }
  try {
    await WidgetSnapshot.clear();
  } catch (err) {
    console.debug("[widget-snapshot] WidgetSnapshot bridge unavailable:", err);
    return;
  }
  removeLocalSetting(SNAPSHOT_ASSISTANT_ID_KEY);
}
