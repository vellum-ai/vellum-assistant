/**
 * Notification factory backed by the native notifier addon.
 *
 * Electron's notification path cannot attach an `INSendMessageIntent`, so the
 * assistant avatar can only become the notification icon by going around it.
 * This module supplies the `create` and `isSupported` seams that
 * `@vellumai/electron-desktop/notifications` calls, and shapes the payload the
 * addon expects: with a sender the assistant's name is the title and the
 * conversation title drops to the subtitle, which is the layout Communication
 * Notifications render (avatar large, app icon badged in the corner). A
 * notification with no sender has nothing to gain from the addon, so `create`
 * hands it to Electron's presenter instead.
 *
 * `isSupported` has to be supplied alongside `create`: the shared module falls
 * back to `electron.Notification.isSupported()`, and merely calling that
 * constructs Electron's presenter, which claims the notification center's
 * delegate before the addon can.
 */

import { createHash, randomUUID } from "node:crypto";

import { app } from "electron";

import { resolveNotificationAvatarPath } from "@vellumai/electron-desktop/notification-avatar-path";
import {
  CATEGORY_ACTIONS,
  createElectronNotification,
  NOTIFICATION_CATEGORIES,
  type CategoryAction,
  type NotificationCreateOptions,
  type NotificationLike,
} from "@vellumai/electron-desktop/notifications";

import log from "./logger";
import {
  ensureNotifierDelegate,
  getNotifier,
  isNotifierSupported,
  registerNotifierCategories,
  type NotifierCategory,
  type NotifierRequest,
} from "./notifier";

type Listeners = {
  click?: () => void;
  action?: (event: unknown, index: number) => void;
  show?: () => void;
  failed?: (event: unknown, error: string) => void;
};

/**
 * The addon registers one `UNNotificationCategory` per identifier and hands the
 * notification center the union, so an identifier shared by two different
 * action sets would let the later registration relabel or drop the buttons on a
 * notification already on screen, and a press would then be routed through the
 * earlier notification's action array. Keying the identifier by the ordered
 * action labels gives every distinct set its own category, an empty set
 * included, and keeps a repeated set on the one registration.
 */
const categoryIdForLabels = (labels: readonly string[]): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify(labels))
    .digest("hex")
    .slice(0, 16);
  return `vellum.actions.${digest}`;
};

const categoryIdForActions = (actions: readonly CategoryAction[]): string =>
  categoryIdForLabels(actions.map((action) => action.text));

/**
 * Registers every category up front.
 *
 * `setNotificationCategories:` applies asynchronously, so a category first
 * registered in the runloop turn its notification is posted can miss it and
 * the buttons never render. Registering at startup gives macOS the whole set
 * long before the first notification. The set is derived from the shared
 * category list, so it covers every action set the app can post and a new
 * category needs no second edit here.
 */
export const registerNativeNotificationCategories = (): void => {
  // Keyed by identifier: two categories with the same ordered labels mint the
  // same one, and the same definition with it, so they register once.
  const byId = new Map<string, NotifierCategory>();
  for (const category of NOTIFICATION_CATEGORIES) {
    const actions = CATEGORY_ACTIONS[category].map((action) => action.text);
    const categoryId = categoryIdForLabels(actions);
    byId.set(categoryId, { categoryId, actions });
  }
  registerNotifierCategories([...byId.values()]);
};

export const createNativeNotificationFactory = (): {
  create: (options: NotificationCreateOptions) => NotificationLike;
  isSupported: () => boolean;
} => ({
  isSupported: isNotifierSupported,
  create: (options) => {
    // The addon exists for one thing Electron cannot do: render the assistant
    // avatar as the icon. A notification with no sender has nothing to gain
    // from it, so Electron's presenter takes it, which is also what makes the
    // `push-avatar-sender` flag a kill switch.
    const sender = options.sender;
    if (!sender) {
      const notification = createElectronNotification(options);
      return {
        on: notification.on.bind(notification) as NotificationLike["on"],
        show: () => {
          notification.show();
          // Electron's presenter takes the notification center's delegate when
          // it is built and drops responses for identifiers it does not own,
          // so the addon's proxy goes straight back in front of it.
          ensureNotifierDelegate();
        },
      };
    }

    const listeners: Listeners = {};
    const on = ((event: string, listener: unknown): void => {
      Object.assign(listeners, { [event]: listener });
    }) as NotificationLike["on"];

    const resolveSender = (): NotifierRequest["sender"] => {
      // The addon reads the avatar from disk: Intents takes image data, not a
      // buffer over IPC.
      const avatarPngPath = resolveNotificationAvatarPath(
        sender,
        app.getPath("userData"),
        log,
      );
      if (!avatarPngPath) {
        return undefined;
      }
      return {
        id: sender.id,
        name: sender.name,
        avatarPngPath,
        // Groups every notification from one assistant into a single
        // conversation in Notification Center.
        conversationId: sender.id,
      };
    };

    const show = (): void => {
      const notifier = getNotifier();
      if (!notifier) {
        listeners.failed?.(undefined, "Native notifier unavailable");
        return;
      }
      const resolved = resolveSender();
      const request: NotifierRequest = {
        id: randomUUID(),
        title: resolved ? resolved.name : options.title,
        ...(resolved ? { subtitle: options.title } : {}),
        body: options.body,
        categoryId: categoryIdForActions(options.actions),
        actions: options.actions.map((action) => action.text),
        ...(resolved ? { sender: resolved } : {}),
      };
      try {
        notifier.show(request, (event) => {
          if (event.kind === "shown") {
            if (event.degraded) {
              log.warn(
                "[notifications] posted without the avatar:",
                event.degraded,
              );
            }
            listeners.show?.();
          } else if (event.kind === "failed") {
            listeners.failed?.(
              undefined,
              event.error ?? "Native notification failed",
            );
          } else if (event.kind === "click") {
            listeners.click?.();
          } else if (
            event.kind === "action" &&
            event.actionIndex !== undefined
          ) {
            // An action without a readable index is dropped: defaulting could
            // route an ambiguous press as e.g. a tool-call "Allow".
            listeners.action?.(undefined, event.actionIndex);
          }
        });
      } catch (error) {
        listeners.failed?.(
          undefined,
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    return { on, show };
  },
});
