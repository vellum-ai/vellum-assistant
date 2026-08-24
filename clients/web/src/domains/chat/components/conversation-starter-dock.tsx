/**
 * The plain empty state's bottom dock for conversation-starter chips.
 *
 * When the dock reserves, it holds the chips' full height from the first
 * frame, before the daemon has answered, so the greeting + composer group
 * centered above it lands at its final position and stays there. An invisible
 * grid of two-line chips sets that height and stays mounted underneath the
 * real chips as a sizing floor, so a short answer cannot shrink the dock
 * either. Whether reserving is worth it is the caller's call: an assistant
 * that produces no chips is better served by a dock that never takes the
 * space at all (see `starters-availability-storage`).
 *
 * The reveal is bound to the presence of chips rather than played on mount,
 * so a dock that mounts with cached chips renders them already in place and
 * only a genuine wait-then-arrive plays the fade.
 *
 * Collapsing an empty dock is `ChatBody`'s job, not this component's: the
 * height to give back includes the padding of the column this renders into,
 * which lives one level up.
 */

import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import {
  CONVERSATION_STARTER_CHIP_BOX,
  CONVERSATION_STARTER_CHIP_LINE,
} from "@/domains/chat/components/conversation-starter-chip";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import { MAX_CONVERSATION_STARTER_CHIPS } from "@/domains/chat/utils/empty-state-constants";
import { useTranslation } from "@/i18n";

const FADE =
  "transition-opacity duration-300 ease-out motion-reduce:transition-none";

const PLACEHOLDER_SLOTS = Array.from(
  { length: MAX_CONVERSATION_STARTER_CHIPS },
  (_, index) => index,
);

/** Non-breaking space: two of them give the placeholder chip two line boxes. */
const BLANK_LINE = "\u00a0";

export interface ConversationStarterDockProps {
  /** Chips to render once the daemon has produced them. */
  starters: readonly ConversationStarter[];
  /**
   * True when the dock holds the chips' worst-case height whether or not any
   * chip is in hand. False leaves the dock the size of whatever it has, which
   * is nothing at all until chips land.
   */
  isReserving: boolean;
  /** Invoked with the full starter object when a chip is clicked. */
  onSelect: (starter: ConversationStarter) => void;
}

export function ConversationStarterDock({
  starters,
  isReserving,
  onSelect,
}: ConversationStarterDockProps) {
  const { t } = useTranslation("chat");
  const hasStarters = starters.length > 0;
  const revealClass = `${FADE} ${hasStarters ? "opacity-100" : "opacity-0"}`;

  // Neither chips nor a reserve leaves the panel's own framing as the only
  // thing in it, which is dead space under whatever shares the slot (the
  // credits card). `ChatBody` still mounts the wrapper around this, so a
  // later answer expands into it rather than snapping in.
  if (!hasStarters && !isReserving) {
    return null;
  }

  return (
    // Top corners only, and `-mb-3` swallows the enclosing column's bottom
    // padding so the panel sits flush against the viewport's bottom edge.
    <div
      data-slot="conversation-starter-dock"
      className="-mb-3 rounded-t-2xl px-6 pt-5 pb-6"
    >
      <p
        aria-hidden={hasStarters ? undefined : "true"}
        className={`mb-4 text-center text-body-medium-default text-[var(--content-tertiary)] ${revealClass}`}
      >
        {t("conversationStarterDock.caption")}
      </p>
      <div className="grid">
        {isReserving ? (
          // Sizing floor: an invisible grid of two-line chips holds the dock
          // at the tallest the real chips reach, in the same grid cell they
          // land in, so neither their arrival nor their length moves anything
          // above the dock.
          <div
            aria-hidden="true"
            className="invisible col-start-1 row-start-1"
            data-slot="conversation-starter-dock-reserve"
          >
            <div className="grid grid-cols-2 gap-4">
              {PLACEHOLDER_SLOTS.map((slot) => (
                <div
                  key={slot}
                  className={`${CONVERSATION_STARTER_CHIP_BOX} bg-[var(--surface-lift)]`}
                >
                  <span className={`block ${CONVERSATION_STARTER_CHIP_LINE}`}>
                    {BLANK_LINE}
                    <br />
                    {BLANK_LINE}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className={`col-start-1 row-start-1 self-start ${revealClass}`}>
          <ConversationStarterGrid starters={starters} onSelect={onSelect} />
        </div>
      </div>
    </div>
  );
}
