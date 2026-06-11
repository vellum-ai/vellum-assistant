import { BrowserWindow, Notification } from "electron";
import { z } from "zod";

import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationActionEvent,
  type ShowNotificationPayload,
  showNotificationPayloadSchema,
} from "@vellumai/ipc-contract";

import { handle } from "./ipc";
import { ensureVisible } from "./main-window";
import log from "./logger";

/**
 * macOS native notifications with category-based action buttons.
 *
 * Uses `electron.Notification` in the main process — NOT the renderer's
 * Web Notification API — because:
 *
 *   1. Main-process `Notification` supports `actions` (macOS action
 *      buttons). The renderer's Web Notification API does not.
 *   2. macOS prompts the *bundle* for notification permission on the
 *      first `.show()`, not per-renderer. The main-process API
 *      bypasses the renderer permission handler entirely.
 *   3. Click and action events route through main, so we can bring the
 *      window to front and dispatch actions via IPC without the
 *      renderer needing to hold a reference to the notification.
 *
 * The renderer drives notifications through two IPC surfaces:
 *
 *   - `vellum:notifications:show` (invoke) — renderer asks main to
 *     post a notification; resolves with `{ success, errorMessage? }`.
 *   - `vellum:notifications:action` (send to renderer) — main
 *     broadcasts click/action events so the renderer can navigate,
 *     approve/reject tool calls, etc.
 *
 * Reference: https://www.electronjs.org/docs/latest/api/notification
 * Reference: https://www.electronjs.org/docs/latest/api/structures/notification-action
 */

// ---------------------------------------------------------------------------
// Notification categories
// ---------------------------------------------------------------------------

/**
 * Discriminated union of notification categories. Each variant declares
 * its action buttons and the metadata needed to route the user's
 * interaction back to the renderer.
 *
 * The four categories mirror the Swift app's
 * `UNNotificationCategory` registrations.
 */
export { NOTIFICATION_CATEGORIES, type NotificationCategory };

interface CategoryAction {
  type: "button";
  text: string;
}

/**
 * Action buttons per category. Mirrors the Swift app's
 * `UNNotificationCategory` registrations in
 * `clients/macos/.../App/AppDelegate+Notifications.swift` so users see the
 * same affordances and identical button labels on Electron and macOS.
 *
 * `activityComplete`      → "View Results" (navigate to the thread)
 * `toolConfirmation`      → "Allow" / "Deny"
 * `voiceResponseComplete` → "View Response"
 * `notificationIntent`    → "View" (follow the deep link)
 */
const CATEGORY_ACTIONS: Record<NotificationCategory, CategoryAction[]> = {
  activityComplete: [{ type: "button", text: "View Results" }],
  toolConfirmation: [
    { type: "button", text: "Allow" },
    { type: "button", text: "Deny" },
  ],
  voiceResponseComplete: [{ type: "button", text: "View Response" }],
  notificationIntent: [{ type: "button", text: "View" }],
};

/**
 * Per-category cooldown thresholds (milliseconds). Suppresses duplicate
 * notifications within this window. Tool confirmations always fire
 * (cooldown 0); activity completions suppress repeats within 30 s.
 */
const CATEGORY_COOLDOWN_MS: Record<NotificationCategory, number> = {
  activityComplete: 30_000,
  toolConfirmation: 0,
  voiceResponseComplete: 10_000,
  notificationIntent: 10_000,
};

// ---------------------------------------------------------------------------
// IPC payload schemas
// ---------------------------------------------------------------------------

export type { ShowNotificationPayload };

const showPayloadSchema = z.tuple([showNotificationPayloadSchema]);

// ---------------------------------------------------------------------------
// Notification action event (main → renderer)
// ---------------------------------------------------------------------------

export type { NotificationActionEvent };

// ---------------------------------------------------------------------------
// Dedup / cooldown
// ---------------------------------------------------------------------------

/** `dedupKey → lastShownTimestamp` */
const recentNotifications = new Map<string, number>();

const dedupKey = (payload: ShowNotificationPayload): string =>
  payload.deliveryId ??
  `${payload.category}:${payload.title}:${payload.body}`;

const isCoolingDown = (payload: ShowNotificationPayload): boolean => {
  const key = dedupKey(payload);
  const cooldown = CATEGORY_COOLDOWN_MS[payload.category];
  if (cooldown === 0) {
    return false;
  }
  const lastShown = recentNotifications.get(key);
  if (lastShown === undefined) {
    return false;
  }
  return Date.now() - lastShown < cooldown;
};

const recordShown = (payload: ShowNotificationPayload): void => {
  recentNotifications.set(dedupKey(payload), Date.now());
};

// Periodically prune stale entries so the map doesn't grow unbounded.
const PRUNE_INTERVAL_MS = 60_000;
const MAX_COOLDOWN = Math.max(...Object.values(CATEGORY_COOLDOWN_MS));

const pruneStaleEntries = (): void => {
  const cutoff = Date.now() - MAX_COOLDOWN;
  for (const [key, timestamp] of recentNotifications) {
    if (timestamp < cutoff) {
      recentNotifications.delete(key);
    }
  }
};

// ---------------------------------------------------------------------------
// Delivery confirmation
// ---------------------------------------------------------------------------

/**
 * `electron.Notification` delivery is asynchronous: after `.show()`, macOS
 * reports the outcome via a `show` event (displayed) or a `failed` event
 * (rejected — e.g. an unsigned build, which always emits `failed` because
 * UNNotification requires code-signing on Electron 42+). There is no
 * synchronous result and no API to read authorization state, so the IPC
 * result is resolved from whichever event fires and the renderer acks the
 * daemon with the real outcome — never optimistically. This mirrors the
 * Swift client, which acks only after `UNUserNotificationCenter.add(...)`'s
 * completion handler resolves.
 *
 * Unlike the Swift client, Electron cannot request authorization up front, so
 * the very first notification races the macOS permission prompt — neither
 * event fires until the user answers. The timeout is deliberately generous so
 * a user who takes a few seconds to click "Allow" still acks as delivered;
 * only a genuinely unanswered or dropped notification falls through to the
 * conservative "not confirmed" failure ack.
 */
const DELIVERY_TIMEOUT_MS = 30_000;

// Overridable so tests don't wait the full timeout for the no-event path.
let deliveryTimeoutMs = DELIVERY_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// Show notification
// ---------------------------------------------------------------------------

const broadcastAction = (event: NotificationActionEvent): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    win.webContents.send("vellum:notifications:action", event);
  }
};

interface ShowResult {
  success: boolean;
  errorMessage?: string;
}

const showNotification = (payload: ShowNotificationPayload): Promise<ShowResult> => {
  if (!Notification.isSupported()) {
    return Promise.resolve({
      success: false,
      errorMessage: "Notifications not supported",
    });
  }

  if (isCoolingDown(payload)) {
    // An equivalent was delivered within the cooldown window — treat as a
    // successful delivery (the user already saw it). Matches the Swift
    // client, which also acks a suppressed duplicate as success.
    return Promise.resolve({ success: true });
  }

  const actions = CATEGORY_ACTIONS[payload.category];

  const notif = new Notification({
    title: payload.title,
    body: payload.body,
    silent: false,
    actions,
  });

  // Build the metadata forwarded on every interaction so the renderer
  // can route without maintaining its own notification lookup table.
  const baseMeta = {
    category: payload.category,
    deliveryId: payload.deliveryId,
    conversationId: payload.conversationId,
    toolCallId: payload.toolCallId,
    deepLinkMetadata: payload.deepLinkMetadata,
  };

  notif.on("click", () => {
    void ensureVisible();
    broadcastAction({ kind: "click", ...baseMeta });
  });

  notif.on("action", (_event: Electron.Event, index: number) => {
    void ensureVisible();
    const actionDef = actions[index];
    broadcastAction({
      kind: "action",
      actionIndex: index,
      actionText: actionDef?.text,
      ...baseMeta,
    });
  });

  // Resolve the IPC result from the real delivery outcome so the renderer
  // acks the daemon with what actually happened. The `show` event can fire
  // more than once, so guard with `settled`.
  return new Promise<ShowResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (result: ShowResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      // Neither event fired in time — e.g. the user never answered the
      // first-run permission prompt, or the OS dropped it. Report failure
      // conservatively so the audit trail doesn't record a phantom delivery.
      settle({
        success: false,
        errorMessage: "Notification delivery not confirmed",
      });
    }, deliveryTimeoutMs);
    // Don't let a pending delivery timeout keep the process alive on quit.
    timer.unref?.();

    notif.on("show", () => {
      recordShown(payload);
      settle({ success: true });
    });

    notif.on("failed", (_event, error) => {
      // Electron delivers the `failed` error as a string description.
      log.warn("[notifications] Notification failed:", error);
      settle({ success: false, errorMessage: error });
    });

    notif.show();
  });
};

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

let pruneTimer: NodeJS.Timeout | null = null;

export const installNotifications = (): void => {
  handle(
    "vellum:notifications:show",
    showPayloadSchema,
    ([payload]) => showNotification(payload),
  );

  pruneTimer = setInterval(pruneStaleEntries, PRUNE_INTERVAL_MS);
};

// Test seam
export const __resetForTesting = (): void => {
  recentNotifications.clear();
  deliveryTimeoutMs = DELIVERY_TIMEOUT_MS;
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
};

// Test seam — shrink the delivery-confirmation timeout so the no-event path
// can be exercised without waiting the full production duration.
export const __setDeliveryTimeoutForTesting = (ms: number): void => {
  deliveryTimeoutMs = ms;
};
