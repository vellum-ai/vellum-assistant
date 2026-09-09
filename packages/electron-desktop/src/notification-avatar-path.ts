import { ensureNotificationAvatarFile } from "./notification-avatar-file";
import type { NotificationSenderImage } from "./notifications";

/**
 * The sender avatar's path on disk, or null when the notification carries no
 * sender or the file could not be written.
 *
 * Every OS draws a notification's sender image from a file, so each platform's
 * factory stages the bytes through the shared cache before it posts. A cache
 * failure must not cost the user the notification, so a throw is logged and
 * reported as "no avatar", which each caller renders as its plain app-icon
 * layout.
 */
export const resolveNotificationAvatarPath = (
  sender: NotificationSenderImage | undefined,
  userDataDir: string,
  logger: { warn: (...args: unknown[]) => void },
): string | null => {
  if (!sender) {
    return null;
  }
  try {
    return ensureNotificationAvatarFile(
      userDataDir,
      sender.avatarPng,
      sender.avatarHash,
    );
  } catch (error) {
    logger.warn(
      "[notifications] Could not store the notification avatar:",
      error,
    );
    return null;
  }
};
