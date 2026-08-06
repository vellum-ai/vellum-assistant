import { BrowserWindow, Notification, type WebContents } from "electron";
import { z } from "zod";

import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationActionEvent,
  type ShowNotificationPayload,
  showNotificationPayloadSchema,
} from "@vellumai/ipc-contract";

import { handle, on } from "./ipc";
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
 * Action buttons per category.
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
  pruneStaleLiveNotifications();
};

// ---------------------------------------------------------------------------
// Liveness — keeping `Notification` objects reachable
// ---------------------------------------------------------------------------

/**
 * Notifications still on screen, held so their `click` handler survives.
 *
 * `new Notification(...)` is function-local: once the delivery promise
 * settles (on `show`, milliseconds later) nothing in the process references
 * it, and V8 is free to collect it. The macOS banner long outlives that --
 * it sits in Notification Center for hours. Clicking a collected one still
 * activates the app, because macOS does that itself, but fires no `click`
 * in the main process: no `broadcastAction`, no deep link, and the renderer
 * lands on its bootstrap default -- the user's most recent conversation.
 * The tap is gone with no error anywhere.
 *
 * That is the shape of the bug this map exists to prevent: not a crash, a
 * notification that quietly stops being clickable some seconds after it
 * appears. Keeping a reference until the OS is done with the banner is the
 * documented requirement for `electron.Notification`, the same one `Tray`
 * carries.
 *
 * Entries are released on `click` / `close` / `failed`, and swept by TTL as
 * a backstop -- macOS does not guarantee `close` for a banner that ages out
 * of Notification Center, so without the sweep a long-running app would
 * accumulate them.
 */
interface LiveNotification {
  notif: Electron.Notification;
  shownAt: number;
}
const liveNotifications = new Map<number, LiveNotification>();
let liveNotificationSeq = 0;

/**
 * How long a banner stays clickable. Generous because that is the whole
 * point -- a notification the user gets to after lunch must still deep-link
 * -- but bounded so an always-on desktop app does not hold every
 * notification it has ever shown.
 */
const LIVE_NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling, in case a burst outpaces the TTL sweep. */
const MAX_LIVE_NOTIFICATIONS = 256;

const retainNotification = (notif: Electron.Notification): number => {
  const id = ++liveNotificationSeq;
  liveNotifications.set(id, { notif, shownAt: Date.now() });
  while (liveNotifications.size > MAX_LIVE_NOTIFICATIONS) {
    const oldest = liveNotifications.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    liveNotifications.delete(oldest);
  }
  return id;
};

const releaseNotification = (id: number): void => {
  liveNotifications.delete(id);
};

const pruneStaleLiveNotifications = (): void => {
  const cutoff = Date.now() - LIVE_NOTIFICATION_TTL_MS;
  for (const [id, entry] of liveNotifications) {
    if (entry.shownAt < cutoff) {
      liveNotifications.delete(id);
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

/**
 * Taps arriving before a renderer is listening, queued for the drain the
 * renderer performs on mount.
 *
 * A tap is the one notification event with nowhere else to go: clicking a
 * banner while the app is closed (or still booting) is precisely when the
 * user most expects to land on the conversation, and it is also when no
 * renderer exists to receive the broadcast. `ensureVisible()` opens the
 * window, but `webContents.send` on the next line reaches a renderer that
 * has not yet subscribed -- and an un-listened `send` is dropped, not
 * queued. Buffering here is the same shape `deep-links.ts` uses for
 * `vellum://thread/...`, which has the identical cold-launch problem.
 *
 * Bounded because a buffered tap is only worth replaying while it still
 * describes what the user just clicked; past the cap the oldest go.
 */
const MAX_PENDING_ACTIONS = 16;
const pendingActions: NotificationActionEvent[] = [];

/**
 * Renderers listening for taps, tracked by `WebContents` rather than a
 * count so a window torn down without running its React cleanup cannot
 * leak a subscriber and silently flip buffering off for every later tap.
 * Mirrors the subscriber model in `deep-links.ts`.
 */
const actionSubscribers = new Set<WebContents>();

const broadcastAction = (event: NotificationActionEvent): void => {
  // Logged unconditionally: every previous way a tap could go missing did so
  // in silence, which is why diagnosing one needed the source rather than a
  // feedback bundle. A tap reaching main is now always on the record.
  log.info("[notifications] tap received", {
    kind: event.kind,
    category: event.category,
    hasConversationId: event.conversationId != null,
    subscribers: actionSubscribers.size,
    buffered: actionSubscribers.size === 0,
  });
  if (actionSubscribers.size === 0) {
    pendingActions.push(event);
    if (pendingActions.length > MAX_PENDING_ACTIONS) {
      pendingActions.shift();
    }
  }
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

  // Hold the object reachable for as long as the banner is clickable.
  // Registered before the handlers so nothing can observe an unretained
  // notification. See `liveNotifications` for why this is load-bearing.
  const liveId = retainNotification(notif);

  notif.on("click", () => {
    releaseNotification(liveId);
    void ensureVisible();
    broadcastAction({ kind: "click", ...baseMeta });
  });

  notif.on("action", (_event: Electron.Event, index: number) => {
    releaseNotification(liveId);
    void ensureVisible();
    const actionDef = actions[index];
    broadcastAction({
      kind: "action",
      actionIndex: index,
      actionText: actionDef?.text,
      ...baseMeta,
    });
  });

  // The user dismissed the banner (or the OS retired it) without acting.
  notif.on("close", () => {
    releaseNotification(liveId);
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
      releaseNotification(liveId);
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

  // Renderer drains on mount; returns AND clears the buffer. Whether a
  // later tap is buffered is governed by `actionSubscribers`, not by
  // whether drain has run.
  handle("vellum:notifications:drainActions", z.tuple([]), () =>
    pendingActions.splice(0, pendingActions.length),
  );

  // Subscriber accounting. The preload sends these around its
  // `ipcRenderer.on` registration; the `destroyed` listener covers the
  // window-close path, where the JS context dies before React effect
  // cleanup can run.
  on("vellum:notifications:subscribeActions", z.tuple([]), (_args, event) => {
    if (actionSubscribers.has(event.sender)) {
      return;
    }
    actionSubscribers.add(event.sender);
    event.sender.once("destroyed", () => {
      actionSubscribers.delete(event.sender);
    });
  });
  on("vellum:notifications:unsubscribeActions", z.tuple([]), (_args, event) => {
    actionSubscribers.delete(event.sender);
  });

  pruneTimer = setInterval(pruneStaleEntries, PRUNE_INTERVAL_MS);
};

// Test seam
export const __resetForTesting = (): void => {
  recentNotifications.clear();
  liveNotifications.clear();
  liveNotificationSeq = 0;
  actionSubscribers.clear();
  pendingActions.length = 0;
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

// Test seams — assert that shown notifications stay reachable (and are
// released) without reaching into module internals from the test.
export const __liveNotificationCountForTesting = (): number =>
  liveNotifications.size;
export const __pruneForTesting = (): void => {
  pruneStaleEntries();
};
