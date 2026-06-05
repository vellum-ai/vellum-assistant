import { BrowserWindow, Notification } from "electron";
import { z } from "zod";

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
export type NotificationCategory =
  | "activityComplete"
  | "toolConfirmation"
  | "voiceResponseComplete"
  | "notificationIntent";

export const NOTIFICATION_CATEGORIES = [
  "activityComplete",
  "toolConfirmation",
  "voiceResponseComplete",
  "notificationIntent",
] as const;

interface CategoryAction {
  type: "button";
  text: string;
}

/**
 * Action buttons per category. Matches the Swift app's category
 * registrations so users see the same affordances on Electron.
 *
 * `activityComplete`      → "View" (navigate to the thread)
 * `toolConfirmation`      → "Approve" / "Reject"
 * `voiceResponseComplete` → (no actions — body click navigates)
 * `notificationIntent`    → "Open" (follow the deep link)
 */
const CATEGORY_ACTIONS: Record<NotificationCategory, CategoryAction[]> = {
  activityComplete: [{ type: "button", text: "View" }],
  toolConfirmation: [
    { type: "button", text: "Approve" },
    { type: "button", text: "Reject" },
  ],
  voiceResponseComplete: [],
  notificationIntent: [{ type: "button", text: "Open" }],
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

const showPayloadSchema = z.tuple([
  z.object({
    category: z.enum(NOTIFICATION_CATEGORIES),
    title: z.string(),
    body: z.string(),
    /** Daemon delivery id — used as dedup key and passed back on action. */
    deliveryId: z.string().optional(),
    /** Conversation or resource id for deep-link routing. */
    conversationId: z.string().optional(),
    /** Tool call id for approve/reject routing. */
    toolCallId: z.string().optional(),
    /** Arbitrary deep-link metadata forwarded back to renderer on action. */
    deepLinkMetadata: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export type ShowNotificationPayload = z.infer<typeof showPayloadSchema>[0];

// ---------------------------------------------------------------------------
// Notification action event (main → renderer)
// ---------------------------------------------------------------------------

export interface NotificationActionEvent {
  /** Which interaction triggered this event. */
  kind: "click" | "action";
  /** The category of the originating notification. */
  category: NotificationCategory;
  /** Zero-based index of the action button pressed (`kind === "action"`). */
  actionIndex?: number;
  /** Text label of the action button pressed. */
  actionText?: string;
  /** Daemon delivery id from the original notification. */
  deliveryId?: string;
  /** Conversation id for deep-link routing. */
  conversationId?: string;
  /** Tool call id for approve/reject routing. */
  toolCallId?: string;
  /** Deep-link metadata forwarded from the original notification. */
  deepLinkMetadata?: Record<string, unknown>;
}

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
// Permission tracking
// ---------------------------------------------------------------------------

/**
 * macOS prompts for notification permission at the bundle level on the
 * first `.show()`. There's no programmatic API to read permission state
 * in Electron — we track our own based on whether `.show()` delivered
 * or the `failed` event fired (unsigned dev builds always emit `failed`
 * because UNNotification requires code-signing on Electron 42+).
 */
type PermissionState = "unknown" | "granted" | "denied";
let permissionState: PermissionState = "unknown";

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

/** How long to wait for macOS to confirm/reject delivery before falling back. */
export const DELIVERY_TIMEOUT_MS = 5_000;

const showNotification = async (
  payload: ShowNotificationPayload,
): Promise<ShowResult> => {
  if (!Notification.isSupported()) {
    return { success: false, errorMessage: "Notifications not supported" };
  }

  if (permissionState === "denied") {
    return {
      success: false,
      errorMessage: "Notification permission denied",
    };
  }

  if (isCoolingDown(payload)) {
    // Treated as successful delivery — the user already saw a recent one.
    return { success: true };
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

  // Await actual delivery confirmation from macOS before reporting
  // success. The `show` event fires when macOS accepts the notification;
  // `failed` fires when it's rejected (e.g. unsigned build, user denied).
  const delivery = new Promise<ShowResult>((resolve) => {
    const timer = setTimeout(() => {
      log.warn(
        "[notifications] Delivery confirmation timed out — assuming success",
      );
      permissionState = "granted";
      recordShown(payload);
      resolve({ success: true });
    }, DELIVERY_TIMEOUT_MS);

    notif.on("show", () => {
      clearTimeout(timer);
      permissionState = "granted";
      recordShown(payload);
      resolve({ success: true });
    });

    notif.on("failed", (_event, error) => {
      clearTimeout(timer);
      log.warn("[notifications] Notification failed:", error);
      permissionState = "denied";
      resolve({ success: false, errorMessage: "Notification delivery failed" });
    });
  });

  // Interaction handlers — fire later when the user clicks/taps an
  // action button, not tied to the delivery outcome.
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

  notif.show();

  return delivery;
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
  permissionState = "unknown";
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
};
