import { BusyIndicator } from "@/domains/chat/components/busy-indicator";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

/**
 * Empty-state hero for a fresh chat: the serif greeting headline. The
 * avatar itself lives in `ComposerPeek` (hanging from the top of the
 * screen, or peeking behind the input), not beside the headline.
 * Presentational only — the composer and conversation-starter chips are
 * rendered by the parent `ChatBody` in the same flex column so that
 * greeting → composer → starters appear as one vertically-centered group.
 *
 * Centering and overflow handling live on `ChatBody` (`overflow-y-auto`
 * on its outer scroll container, `justify-content: safe center` on an
 * inner `min-h-full` wrapper), not here. This component just renders its
 * content at natural height.
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
}

export function ChatEmptyState({
  greeting = DEFAULT_EMPTY_STATE_GREETING,
  isGenerating = false,
}: ChatEmptyStateProps) {
  return (
    // Extra bottom padding over the top: the greeting reads as its own
    // group with clear air above the composer (Figma: New-App 7471-25035).
    <div className="pt-8 pb-16">
      <div className="mx-auto w-full max-w-[var(--chat-max-width)] px-3 sm:px-6">
        <div className="flex flex-col items-center justify-center">
          {isGenerating ? (
            <BusyIndicator size={10} />
          ) : (
            /* The serif brand headline (Figma "Brand/Medium": Instrument
               Serif 32px) — larger than the old title tokens, scaled down
               a step on mobile. */
            <h1
              className="text-center text-[24px] leading-[1.2] tracking-[0.02em] text-[var(--content-emphasized)] md:text-[32px]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              {greeting}
            </h1>
          )}
        </div>
      </div>
    </div>
  );
}
