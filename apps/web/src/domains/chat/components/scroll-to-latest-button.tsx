import { ArrowDown } from "lucide-react";

import { ChatPill } from "@/domains/chat/components/chat-pill.js";

/**
 * Pill-shaped scroll-to-latest affordance shown when the user has scrolled far
 * enough up that `useTranscriptScroll` reports `showScrollToLatest`. Clicking
 * refetches the latest history page and pins the transcript to the bottom.
 * Rendered as a centered pill above the chat input area by the caller.
 */
export function ScrollToLatestButton({ onClick }: { onClick: () => void }) {
  return (
    <ChatPill onClick={onClick} ariaLabel="Scroll to latest message">
      <ArrowDown className="h-3 w-3" />
      Scroll to latest
    </ChatPill>
  );
}
