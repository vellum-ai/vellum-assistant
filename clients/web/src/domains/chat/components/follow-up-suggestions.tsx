import { ConversationStarterChip } from "@/domains/chat/components/conversation-starter-chip";
import { useTranslation } from "@/i18n";

/**
 * Most chips rendered under a reply. Two is the whole point of the surface: a
 * pair of next moves, small enough to read at a glance without competing with
 * the composer.
 */
export const MAX_FOLLOW_UP_SUGGESTIONS = 2;

/** Inputs to {@link shouldShowFollowUpSuggestions}. */
export interface FollowUpSuggestionsGate {
  /** The `follow-up-suggestions` client flag. Off means the surface is absent. */
  enabled: boolean;
  /** The suggestions the daemon returned for the latest completed reply. */
  suggestions: readonly string[];
  /** True while a turn is streaming or a send is in flight. */
  turnActive: boolean;
  /**
   * True when the latest turn parked on a surface that already asks the user
   * something: an `ask_question` card, or an uncompleted `ui_show` choice,
   * form, or confirmation. Those render their own answers, so a second set of
   * buttons underneath would offer two ways to reply to one question.
   */
  awaitingInteraction: boolean;
}

/**
 * Whether the follow-up chips belong under the latest reply.
 *
 * Split from the component so the gate is one named rule the chat page reads
 * and a test exercises directly, rather than a condition assembled inline at
 * the render site.
 */
export function shouldShowFollowUpSuggestions({
  enabled,
  suggestions,
  turnActive,
  awaitingInteraction,
}: FollowUpSuggestionsGate): boolean {
  if (!enabled || turnActive || awaitingInteraction) {
    return false;
  }
  return suggestions.length > 0;
}

export interface FollowUpSuggestionsProps {
  /**
   * Suggestions in daemon order (strongest first). Anything past
   * {@link MAX_FOLLOW_UP_SUGGESTIONS} is dropped.
   */
  suggestions: readonly string[];
  /**
   * Invoked with the picked suggestion's text. The single click seam for the
   * surface: whatever a chip press should also do (telemetry, for one) hangs
   * here rather than on each chip.
   */
  onSelect: (suggestion: string) => void;
}

/**
 * The pair of tappable follow-ups under the latest assistant reply. Each chip
 * is a short message in the user's own voice; picking one sends it.
 *
 * Renders nothing when there is nothing to suggest, so the caller can mount it
 * unconditionally without reserving an empty row.
 */
export function FollowUpSuggestions({
  suggestions,
  onSelect,
}: FollowUpSuggestionsProps) {
  const { t } = useTranslation("chat");
  const visible = suggestions.slice(0, MAX_FOLLOW_UP_SUGGESTIONS);
  if (visible.length === 0) {
    return null;
  }
  return (
    <div
      // Excluded from a transcript copy the way the parked avatar is: the chips
      // are an affordance the reader can act on, not part of what was said.
      data-copy-exclude
      data-slot="follow-up-suggestions"
      role="group"
      aria-label={t("followUpSuggestions.groupAria")}
      className="grid w-full grid-cols-2 gap-2"
    >
      {visible.map((suggestion) => (
        <ConversationStarterChip
          key={suggestion}
          label={suggestion}
          onSelect={() => onSelect(suggestion)}
        />
      ))}
    </div>
  );
}
