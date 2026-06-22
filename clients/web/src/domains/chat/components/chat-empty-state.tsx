
import { type ReactNode } from "react";

import { BusyIndicator } from "@/domains/chat/components/busy-indicator";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";
import { Typography } from "@vellumai/design-library";

/**
 * Empty-state hero for a fresh chat: optional avatar and greeting headline.
 * Presentational only — the composer and conversation-starter chips are
 * rendered by the parent `ChatBody` in the same flex column so that
 * greeting → composer → starters appear as one vertically-centered group.
 *
 * Centering and overflow handling live on `ChatBody`'s outer container
 * (`justify-content: safe center` + `overflow-y-auto`), not here. This
 * component just renders its content at natural height.
 *
 * See [React — Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state)
 * for why the composer must stay at a fixed tree position rather than
 * being passed as a slot into this component.
 */
export interface ChatEmptyStateProps {
  /** Greeting headline. Defaults to {@link DEFAULT_EMPTY_STATE_GREETING}. */
  greeting?: string;
  /**
   * True while the greeting is still generating and no text has streamed in
   * yet. Renders a busy indicator in place of the headline so the default
   * greeting doesn't flash before the personalized one arrives.
   */
  isGenerating?: boolean;
  /**
   * Optional avatar rendered above the greeting on mobile, or to its left on
   * desktop. Caller passes a
   * `<ChatAvatar … size={40} interactive />` when avatar data is available;
   * omit the slot to render greeting-only.
   */
  avatarSlot?: ReactNode;
}

export function ChatEmptyState({
  greeting = DEFAULT_EMPTY_STATE_GREETING,
  isGenerating = false,
  avatarSlot,
}: ChatEmptyStateProps) {
  return (
    <div className="py-8">
      <div className="mx-auto w-full max-w-[var(--chat-max-width)] px-3 sm:px-6">
        <div className="flex flex-col items-center justify-center gap-3 md:flex-row">
          {avatarSlot}
          {isGenerating ? (
            <BusyIndicator size={10} />
          ) : (
            <>
              <Typography variant="title-medium" className="text-[var(--content-emphasized)] md:hidden">
                {greeting}
              </Typography>
              <Typography variant="title-large" className="hidden text-[var(--content-emphasized)] md:block">
                {greeting}
              </Typography>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
