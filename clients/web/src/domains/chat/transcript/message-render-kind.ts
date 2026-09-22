import type { DisplayMessage } from "@/domains/chat/types/types";
import { isChannelDeleted } from "@/domains/chat/utils/is-channel-deleted";

/** Dispatch order also determines whether a row can render a camera grid. */
export function getMessageRenderKind(message: DisplayMessage) {
  if (isChannelDeleted(message)) {
    return "deleted";
  }
  if (message.isSystemCard) {
    return "systemCard";
  }
  if (message.reaction && !message.slackMessage) {
    return "reaction";
  }
  if (message.isNoResponse) {
    return "noResponse";
  }
  if (message.slackMessage?.eventKind === "reaction") {
    return "slackReaction";
  }
  return message.role === "user" ? "user" : "other";
}
