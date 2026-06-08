import { ConversationStarterChip } from "@/domains/chat/components/conversation-starter-chip";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import { MAX_CONVERSATION_STARTER_CHIPS } from "@/domains/chat/utils/empty-state-constants";

export interface ConversationStarterGridProps {
  /**
   * Starters to render. Server returns these in strongest-first order; we
   * preserve that order and drop any items beyond {@link maxVisible}.
   */
  starters: readonly ConversationStarter[];
  /** Invoked with the full starter object when a chip is clicked. */
  onSelect: (starter: ConversationStarter) => void;
  /**
   * Maximum number of chips rendered. Items beyond this cap are dropped.
   * Defaults to {@link MAX_CONVERSATION_STARTER_CHIPS}.
   */
  maxVisible?: number;
}

/**
 * 2-column grid wrapper that renders up to `maxVisible` conversation-starter
 * chips for the chat empty state. Empty input renders nothing (returns
 * `null`) so callers can drop the wrapper unconditionally without producing
 * an empty grid box.
 */
export function ConversationStarterGrid({
  starters,
  onSelect,
  maxVisible = MAX_CONVERSATION_STARTER_CHIPS,
}: ConversationStarterGridProps) {
  const visible = starters.slice(0, maxVisible);
  if (visible.length === 0) {
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      {visible.map((starter) => (
        <ConversationStarterChip
          key={starter.id}
          label={starter.label}
          onSelect={() => onSelect(starter)}
          aria-label={`Send: ${starter.label}`}
        />
      ))}
    </div>
  );
}
