/**
 * Notification factory backed by the native notifier addon.
 *
 * Electron's notification path cannot attach an `INSendMessageIntent`, so the
 * assistant avatar can only become the notification icon by going around it.
 * This module supplies the `create` and `isSupported` seams that
 * `@vellumai/electron-desktop/notifications` calls, and shapes the payload the
 * addon expects: with a sender the assistant's name is the title and the
 * conversation title drops to the subtitle, which is the layout Communication
 * Notifications render (avatar large, app icon badged in the corner).
 *
 * `isSupported` has to be supplied alongside `create`: the shared module falls
 * back to `electron.Notification.isSupported()`, and merely calling that
 * constructs Electron's presenter, which claims the notification center's
 * delegate before the addon can.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { app } from "electron";

import type {
  NotificationCategory,
  NotificationCreateOptions,
  NotificationLike,
} from "@vellumai/electron-desktop/notifications";

import log from "./logger";
import { getNotifier, type NotifierRequest } from "./notifier";

/**
 * The addon reads the avatar from disk (Intents takes image data, not a
 * buffer over IPC), so the PNG is cached under the user data directory keyed
 * by its content hash.
 */
const AVATAR_DIR_NAME = "notification-avatars";
const MAX_AVATAR_FILES = 8;

// The hash arrives over IPC; folding every other character to an underscore is
// what stops a crafted value from naming a path outside the avatar directory,
// while keeping two different hashes on two different filenames.
const sanitizeHash = (avatarHash: string): string =>
  avatarHash.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 64);

// `keepPath` is the avatar this notification is about to hand the addon, so it
// survives the cap no matter how old the cached file is.
const pruneAvatarFiles = (dir: string, keepPath: string): void => {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".png"))
    .map((name) => path.join(dir, name))
    .filter((filePath) => filePath !== keepPath)
    .map((filePath) => ({ filePath, mtimeMs: statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of files.slice(MAX_AVATAR_FILES - 1)) {
    try {
      rmSync(stale.filePath, { force: true });
    } catch {
      // A file another process is holding stays; the cap is advisory.
    }
  }
};

const ensureNotificationAvatarFile = (
  userDataDir: string,
  avatarPng: Buffer,
  avatarHash: string,
): string => {
  const hash = sanitizeHash(avatarHash);
  if (hash.length === 0) {
    throw new Error("Notification avatar hash is empty");
  }
  const dir = path.join(userDataDir, AVATAR_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${hash}.png`);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, avatarPng);
    pruneAvatarFiles(dir, filePath);
  }
  return filePath;
};

type Listeners = {
  click?: () => void;
  action?: (event: unknown, index: number) => void;
  show?: () => void;
  failed?: (event: unknown, error: string) => void;
};

const CATEGORY_ID: NotificationCategory = "notificationIntent";

export const createNativeNotificationFactory = (): {
  create: (options: NotificationCreateOptions) => NotificationLike;
  isSupported: () => boolean;
} => ({
  isSupported: () => getNotifier()?.isSupported() ?? false,
  create: (options) => {
    const listeners: Listeners = {};
    const on = ((event: string, listener: unknown): void => {
      Object.assign(listeners, { [event]: listener });
    }) as NotificationLike["on"];

    const resolveSender = (): NotifierRequest["sender"] => {
      const sender = options.sender;
      if (!sender) {
        return undefined;
      }
      try {
        return {
          id: sender.id,
          name: sender.name,
          avatarPngPath: ensureNotificationAvatarFile(
            app.getPath("userData"),
            sender.avatarPng,
            sender.avatarHash,
          ),
          // Groups every notification from one assistant into a single
          // conversation in Notification Center.
          conversationId: sender.id,
        };
      } catch (error) {
        log.warn("[notifications] could not stage the sender avatar:", error);
        return undefined;
      }
    };

    const show = (): void => {
      const notifier = getNotifier();
      if (!notifier) {
        listeners.failed?.(undefined, "Native notifier unavailable");
        return;
      }
      const sender = resolveSender();
      const request: NotifierRequest = {
        id: randomUUID(),
        title: sender ? sender.name : options.title,
        ...(sender ? { subtitle: options.title } : {}),
        body: options.body,
        categoryId: CATEGORY_ID,
        actions: options.actions.map((action) => action.text),
        ...(sender ? { sender } : {}),
      };
      try {
        notifier.show(request, (event) => {
          if (event.kind === "shown") {
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
