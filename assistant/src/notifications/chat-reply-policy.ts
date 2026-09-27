import { getConfig } from "../config/loader.js";

export const CHAT_REPLY_ALERTS_DISABLED =
  "Chat reply notifications are disabled";

export function areChatReplyAlertsDisabled(sourceEventName: string): boolean {
  return (
    sourceEventName === "chat.assistant_reply" &&
    !getConfig().notifications.newMessageEnabled
  );
}
