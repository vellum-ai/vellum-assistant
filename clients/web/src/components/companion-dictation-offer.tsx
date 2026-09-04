/**
 * The card that offers Vellum's version of a dictation another app pasted.
 *
 * A card beside the pill rather than a body inside it, for the reason the
 * introduction and the Teach picker are: the pill is one line tall and the
 * words have to be read whole to be judged against what landed. The canvas
 * main reserves for a card is where they fit.
 */

import type { CSSProperties, Ref } from "react";

import type {
  CompanionCardGrowth,
  CompanionDictationOffer as CompanionDictationOfferWords,
  CompanionGrowth,
  DictationOfferAnswer,
} from "@vellumai/ipc-contract";
import { COMPANION_BASE_AVATAR_BOX } from "@vellumai/ipc-contract";

import { ScrollShadow } from "@vellumai/design-library/components/scroll-shadow";

import { companionLayoutFor } from "@/components/companion-layout";
import { useTranslation } from "@/i18n";

/** The same fixed width the other cards take, for the same reason. */
const CARD_WIDTH = 260;

export interface CompanionDictationOfferProps {
  offer: CompanionDictationOfferWords;
  growth?: CompanionGrowth;
  cardGrowth?: CompanionCardGrowth;
  avatarBox?: number;
  optionsBox?: number;
  /**
   * The card's own element, for the host to hit-test the pointer against. The
   * window is click-through except where it is told otherwise, and every
   * answer here is a press.
   */
  cardRef?: Ref<HTMLDivElement>;
  /** Absent leaves the answers inert, which is what Storybook wants. */
  onAnswer?: (answer: DictationOfferAnswer) => void;
}

export function CompanionDictationOffer({
  offer,
  growth = "right",
  cardGrowth = "up",
  avatarBox = COMPANION_BASE_AVATAR_BOX,
  optionsBox = COMPANION_BASE_AVATAR_BOX,
  cardRef,
  onAnswer,
}: CompanionDictationOfferProps) {
  const { t } = useTranslation();
  // The same derivation the introduction places its card by: hung off the
  // creature's own edge, since the pill is beside the creature in this phase
  // and its width is the words' rather than a fixed one.
  const { inUnits, avatarHalf, lineAt, edgeAt, introStepOff } =
    companionLayoutFor(avatarBox, optionsBox);
  const stepOff = inUnits(introStepOff(cardGrowth));
  const placement: CSSProperties = edgeAt(growth, -avatarHalf);
  const anchor: CSSProperties = {
    top: lineAt(cardGrowth, 0),
    transform:
      cardGrowth === "up"
        ? `translateY(calc(-100% - ${stepOff}px))`
        : `translateY(${stepOff}px)`,
  };

  return (
    <div
      ref={cardRef}
      // A group rather than a dialog: it takes no focus and traps none, since
      // the window is unfocusable and every answer is the pointer's.
      role="group"
      aria-label={t("companionSurface.offerVersion")}
      data-companion-dictation-offer
      className="absolute flex flex-col gap-2 rounded-2xl border border-white/10 bg-[#17181b]/95 px-3.5 py-3 shadow-lg shadow-black/40"
      style={{ width: CARD_WIDTH, ...placement, ...anchor }}
      // A press here is an answer, not a grab of the surface.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <p className="text-[11px] font-medium tracking-wide text-white/45 uppercase select-none">
        {t("companionSurface.offerVersion")}
      </p>
      {/* Every word that "use" would insert, scrolled rather than clipped:
          the question is whether these words are better than the ones that
          landed, and a preview hiding its own suffix is one the user cannot
          answer. The fade marks the rest the way the capture picker's list
          does, and the scrollbar is hidden for the same reason. */}
      <ScrollShadow
        className="max-h-40 flex-col"
        size={20}
        fadeEdges="end"
        hideScrollBar
      >
        <p dir="auto" className="text-[13px] leading-[1.45] text-white/90">
          {offer.text}
        </p>
      </ScrollShadow>
      <div className="flex flex-wrap items-center justify-end gap-1 pt-0.5">
        <button
          type="button"
          className="h-7 rounded-full px-2.5 text-[12px] text-white/55 transition-colors hover:bg-white/10 hover:text-white/80"
          onClick={() => onAnswer?.("dismiss")}
        >
          {t("companionSurface.notNow")}
        </button>
        <button
          type="button"
          className="h-7 rounded-full px-2.5 text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          onClick={() => onAnswer?.("quit")}
        >
          {t("companionSurface.offerQuit", { app: offer.app })}
        </button>
        <button
          type="button"
          className="h-7 rounded-full bg-white/15 px-3 text-[12px] text-white transition-colors hover:bg-white/25"
          onClick={() => onAnswer?.("use")}
        >
          {t("companionSurface.offerUse")}
        </button>
      </div>
    </div>
  );
}
