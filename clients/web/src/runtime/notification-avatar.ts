import { encodeBase64Bytes } from "@/utils/base64";

/**
 * The notification avatar the Electron host posts as the sender's icon, held
 * for the one module that needs it.
 *
 * Published rather than subscribed, like `use-island-avatar-source.ts`:
 * `postLocalNotification` runs outside React, and the alternative is a canvas
 * draw per notification for a picture that only changes when the avatar does.
 * Nothing here reaches the host; `runtime/notifications.ts` attaches what is
 * held to the IPC payload it is already sending.
 *
 * Empty is the ordinary state. Off Electron, with `push-avatar-sender` off, or
 * for an assistant with no avatar, nothing is stored and notifications keep
 * their app-icon look.
 */
export interface NotificationAvatar {
  /**
   * The assistant this picture was drawn for. `senderPayload()` refuses a face
   * that was not drawn for the notification's own assistant, so after a switch
   * the new assistant's name cannot be sent with the old one's face.
   */
  assistantId: string;
  /** The disc PNG as base64, with no data-URI prefix. */
  avatarBase64: string;
  /** SHA-256 of the PNG bytes, lowercase hex, so a host can name a cache file by it. */
  avatarHash: string;
}

let current: NotificationAvatar | null = null;

export function setNotificationAvatar(
  assistantId: string,
  png: Uint8Array,
  hash: string,
): void {
  current = {
    assistantId,
    avatarBase64: encodeBase64Bytes(png),
    avatarHash: hash,
  };
}

export function getNotificationAvatar(): NotificationAvatar | null {
  return current;
}

export function clearNotificationAvatar(): void {
  current = null;
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
