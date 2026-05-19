// TODO: port from platform
import type { ChatAttachment } from "./index.js";

export type { ChatAttachment };
export function useChatAttachments() {
  return {
    attachments: [] as ChatAttachment[],
    addAttachment: (_file: File) => {},
    removeAttachment: (_id: string) => {},
    clearAttachments: () => {},
  };
}
