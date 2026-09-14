import type { DisplayMessage } from "@/domains/chat/types/types";

export function isCameraFrameRow(message: DisplayMessage): boolean {
  return message.role === "user" && message.isCameraFrame === true;
}
