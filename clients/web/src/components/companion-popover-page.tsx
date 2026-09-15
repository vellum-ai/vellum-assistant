/**
 * The popover's window: what the assistant needs the user to see or answer,
 * beside the companion (see `CompanionPopover`).
 *
 * Opened, placed and shown by the macOS shell
 * (`clients/macos/src/main/companion-popover-window.ts`). The window is sized
 * from the size this page reports for the popover it is drawing, and main
 * shows it only once that report has arrived for the popover on screen.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  COMPANION_POPOVER_INSET,
  COMPANION_POPOVER_MAX_HEIGHT,
  type CompanionSurfaceState,
} from "@vellumai/ipc-contract";

import { companionAccentHexFor } from "@/components/companion-accent";
import { CompanionPopover } from "@/components/companion-popover";
import {
  answerCompanionPopover,
  getCompanionState,
  openCompanionLink,
  setCompanionPopoverSize,
  setCompanionPopoverView,
  subscribeCompanionState,
} from "@/runtime/companion-surface";

export function CompanionPopoverPage() {
  const [state, setState] = useState<CompanionSurfaceState | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = subscribeCompanionState(setState);
    // The route chunk loads lazily after the window is created, so a state
    // pushed before this subscription registered was dropped. Catch up.
    void getCompanionState().then((initial) => {
      if (initial) {
        setState(initial);
      }
    });
    return unsubscribe;
  }, []);

  const popover = state?.popover;
  const popoverId = popover?.id;
  const view = state?.popoverView ?? "row";

  // Reported for every size the card takes, since an image landing or a line
  // wrapping moves it after the first paint, and again on a change of view,
  // which swaps the row for a card of another size under the same popover.
  // Named for the popover, so a report racing a replacement cannot size the
  // next one.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (popoverId === undefined || card === null) {
      return;
    }
    const report = (): void => {
      const { width, height } = card.getBoundingClientRect();
      setCompanionPopoverSize(
        popoverId,
        Math.ceil(width) + COMPANION_POPOVER_INSET * 2,
        Math.ceil(height) + COMPANION_POPOVER_INSET * 2,
      );
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(card);
    return () => {
      observer.disconnect();
    };
  }, [popoverId, view]);

  if (popover === undefined) {
    return null;
  }

  return (
    <div
      // The popover paints its own dark card in every host theme, so the
      // design-library tokens inside it resolve against dark.
      data-theme="dark"
      className="h-screen w-screen bg-transparent select-none"
      style={{ padding: COMPANION_POPOVER_INSET }}
    >
      <CompanionPopover
        // Remounted per popover, so nothing drawn for one carries to the next.
        key={popover.id}
        popover={popover}
        view={view}
        // The colour the call's ring and the creature burn, so the panel reads
        // as the same assistant's.
        accentHex={
          companionAccentHexFor(
            state?.call ?? null,
            state?.accentHex,
            state?.character,
          ) ?? undefined
        }
        cardRef={cardRef}
        style={{
          maxHeight: COMPANION_POPOVER_MAX_HEIGHT - COMPANION_POPOVER_INSET * 2,
        }}
        onAnswer={(answer) => {
          answerCompanionPopover(answer, popover.id);
        }}
        onView={(next) => {
          setCompanionPopoverView(popover.id, next);
        }}
        onOpenLink={(url) => {
          openCompanionLink(url);
        }}
      />
    </div>
  );
}
