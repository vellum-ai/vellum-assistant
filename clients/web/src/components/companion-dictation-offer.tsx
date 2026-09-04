import { Copy, X } from "lucide-react";
import { type CSSProperties, type Ref } from "react";

import { companionLayoutFor } from "@/components/companion-layout";
import { useTranslation } from "@/i18n";
import { ScrollShadow } from "@vellumai/design-library/components/scroll-shadow";
import { COMPANION_BASE_AVATAR_BOX } from "@vellumai/ipc-contract";
import type {
  CompanionCardGrowth,
  CompanionGrowth,
} from "@vellumai/ipc-contract";

/**
 * The words a dictation had nowhere to put, offered back.
 *
 * A hold that ends over something that does not take text used to lose
 * everything the user said: the paste went to whatever the keystroke meant in
 * that application, and nothing anywhere reported it. This card is what stands
 * in for the paste. It draws the whole transcript, because the user is reading
 * it to decide whether it is worth keeping, and offers the one thing that
 * still works from outside their application: the clipboard.
 *
 * **A card, not a row on the pill.** The pill draws one line and clips it, and
 * a line of the middle of a sentence is not something anyone can act on. This
 * is the same card the introduction and the picker are drawn as, on the height
 * the host reserves beside the creature.
 *
 * **It holds nothing.** The text is what main pushed and both answers leave
 * this renderer at once; the copy itself is main's, since main is holding the
 * words and this window has no focus of its own.
 */

/**
 * The card's width, fixed rather than measured, for the reason the
 * introduction's is: a paragraph has no natural width, and a card that took
 * its shape from how long the last sentence happened to be would arrive
 * somewhere different every time.
 */
const CARD_WIDTH = 260;

export interface CompanionDictationOfferProps {
  /** The transcript, whole. */
  text: string;
  growth?: CompanionGrowth;
  cardGrowth?: CompanionCardGrowth;
  avatarBox?: number;
  optionsBox?: number;
  /**
   * The card's own element, for the host to hit-test the pointer against. The
   * companion's window is click-through except where it is told otherwise, and
   * both answers here are presses.
   */
  cardRef?: Ref<HTMLDivElement>;
  /** True takes the words to the clipboard, false lets them go. */
  onAnswer?: (copy: boolean) => void;
}

export function CompanionDictationOffer({
  text,
  growth = "right",
  cardGrowth = "up",
  avatarBox = COMPANION_BASE_AVATAR_BOX,
  optionsBox = COMPANION_BASE_AVATAR_BOX,
  cardRef,
  onAnswer,
}: CompanionDictationOfferProps) {
  const { t } = useTranslation();
  const { inUnits, avatarHalf, lineAt, edgeAt, introStepOff } =
    companionLayoutFor(avatarBox, optionsBox);
  const stepOff = inUnits(introStepOff(cardGrowth));

  // Hung off the creature's own edge, the way the introduction's card is: this
  // is drawn with the pill closed as often as not, and the pill is the one
  // thing beside the creature whose width is nobody's to predict.
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
      // A group rather than a dialog, as everywhere else on this surface: the
      // window takes no focus and traps none, and every press here is the
      // pointer's.
      role="group"
      aria-label={t("companionSurface.dictationOffer")}
      data-companion-dictation-offer
      className="absolute flex flex-col gap-2 rounded-2xl border border-white/10 bg-[#17181b]/95 px-3 py-2.5 shadow-lg shadow-black/40"
      style={{ width: CARD_WIDTH, ...placement, ...anchor }}
      // The card is not a drag handle. A press that both read a paragraph and
      // flung the surface across the desktop would be the worst of both.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <span className="text-[10px] font-medium tracking-wide text-white/35 uppercase select-none">
        {t("companionSurface.dictationOfferTitle")}
      </span>
      {/* The whole transcript, scrolling inside the height the host reserves
          rather than growing the card past the edge of a window that never
          resizes. Selectable on purpose: the surface leaves a right-click on
          selected text alone so the system's own Copy still works, which is
          the way out for someone who wants half of what they said. */}
      <ScrollShadow className="max-h-40 flex-col" size={20} fadeEdges="end">
        <p
          dir="auto"
          className="text-[12px] leading-snug whitespace-pre-wrap text-white/85"
        >
          {text}
        </p>
      </ScrollShadow>
      {/* The answer that keeps the words sits on the right, where the answer
          being offered goes. */}
      <div className="flex items-center justify-end gap-1">
        <OfferButton
          icon={<X className="size-3.5" />}
          label={t("companionSurface.dictationOfferDismiss")}
          onClick={() => {
            onAnswer?.(false);
          }}
        />
        <OfferButton
          icon={<Copy className="size-3.5" />}
          label={t("companionSurface.dictationOfferCopy")}
          primary
          onClick={() => {
            onAnswer?.(true);
          }}
        />
      </div>
    </div>
  );
}

function OfferButton({
  icon,
  label,
  primary = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-white/40 focus-visible:ring-inset ${
        primary
          ? "bg-white/15 text-white hover:bg-white/25 active:bg-white/30"
          : "text-white/70 hover:bg-white/10 hover:text-white active:bg-white/15"
      }`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
