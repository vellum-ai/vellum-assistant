import { ChevronDown } from "lucide-react";

import { ChatPill } from "@/domains/chat/components/chat-pill";

/**
 * Pill-shaped "Go to Newest" affordance shown above the composer when the
 * user has scrolled far enough up that the scroll coordinator reports
 * `showScrollToLatest`. Clicking pins the transcript back to the latest
 * message.
 *
 * When `isAssistantBusy` is true, a 3-dot pulse animation renders at the start
 * of the pill to signal that more content is still arriving out of view —
 * matches the macOS TypingIndicatorView phase pattern used by the inline
 * "thinking" row in `TranscriptRow`.
 */
export function ScrollToLatestButton({
  onClick,
  isAssistantBusy = false,
}: {
  onClick: () => void;
  isAssistantBusy?: boolean;
}) {
  return (
    <ChatPill
      onClick={onClick}
      ariaLabel="Go to newest message"
      size="regular"
      // `max-md:shadow-lg`: the pill needs a stronger shadow on mobile to
      // lift off the busy chat background. The shared ChatPill chrome keeps
      // `shadow-md` on desktop and for the other pill consumers.
      className="text-[var(--content-emphasised)] max-md:shadow-lg"
    >
      {isAssistantBusy && (
        <span
          aria-hidden
          className="inline-flex items-center gap-[3px]"
        >
          {([-0.333, 0, -0.667] as const).map((delay, i) => (
            <span
              key={i}
              className="typing-dot block h-2 w-2 rounded-full bg-[var(--content-tertiary)]"
              style={{
                animation: "typing-dot-pulse 1s ease-in-out infinite",
                animationDelay: `${delay}s`,
              }}
            />
          ))}
        </span>
      )}
      Go to Newest
      <ChevronDown className="h-3 w-3" />
    </ChatPill>
  );
}
