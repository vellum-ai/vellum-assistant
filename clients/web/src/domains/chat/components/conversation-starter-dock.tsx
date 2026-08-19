/**
 * The plain empty state's bottom dock for conversation-starter chips.
 *
 * The dock reserves its full height from the first frame, before the daemon
 * has answered, so the greeting + composer group centered above it lands at
 * its final position immediately and never shifts when chips appear. An
 * invisible grid of two-line chips sets that height; the real chips fade in
 * over it. A starter query that settles with nothing to show (none generated,
 * a transport failure, or an assistant that serves none) collapses the dock
 * through a grid-row transition rather than dropping it out of the layout.
 *
 * The fade is bound to the presence of chips rather than played on mount, so
 * a dock that mounts with cached chips renders them already in place and only
 * a genuine wait-then-arrive plays the reveal.
 */

import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import { CONVERSATION_STARTER_CHIP_BOX } from "@/domains/chat/components/conversation-starter-chip";
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
  /** True while the starter query may still deliver chips. */
  isAwaiting: boolean;
  /** Invoked with the full starter object when a chip is clicked. */
  onSelect: (starter: ConversationStarter) => void;
}

export function ConversationStarterDock({
  starters,
  isAwaiting,
  onSelect,
}: ConversationStarterDockProps) {
  const { t } = useTranslation("chat");
  const hasStarters = starters.length > 0;
  const collapsed = !hasStarters && !isAwaiting;
  const revealClass = `${FADE} ${hasStarters ? "opacity-100" : "opacity-0"}`;

  return (
    <div
      data-slot="conversation-starter-dock"
      data-collapsed={collapsed || undefined}
      inert={collapsed || undefined}
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none${collapsed ? " opacity-0" : ""}`}
      style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
    >
      {/* The clip is only for the collapse: at rest it would shave the
          keyboard-focus rings the chips paint outside their border box. */}
      <div className={`min-h-0${collapsed ? " overflow-hidden" : ""}`}>
        {/* Top corners only, and `-mb-3` swallows the dock wrapper's bottom
            padding so the panel sits flush against the viewport's bottom
            edge. */}
        <div className="-mb-3 rounded-t-2xl px-6 pt-5 pb-6">
          <p
            aria-hidden={hasStarters ? undefined : "true"}
            className={`mb-4 text-center text-body-medium-default text-[var(--content-tertiary)] ${revealClass}`}
          >
            {t("conversationStarterDock.caption")}
          </p>
          <div className="grid">
            {/* Sizing floor: an invisible grid of two-line chips holds the
                dock at the tallest the real chips reach, so chips arriving
                one or two lines long move nothing above them. */}
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
                    <span className="block leading-normal">
                      {BLANK_LINE}
                      <br />
                      {BLANK_LINE}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div
              className={`col-start-1 row-start-1 self-start ${revealClass}`}
            >
              <ConversationStarterGrid
                starters={starters}
                onSelect={onSelect}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
