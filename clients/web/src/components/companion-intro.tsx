import {
  COMPANION_INTRO_BEATS,
  COMPANION_NEAR_EDGE,
} from "@vellumai/ipc-contract";
import type {
  CompanionIntroAction,
  CompanionIntroBeat,
} from "@vellumai/ipc-contract";
import type { CSSProperties, Ref } from "react";

import { useTranslation } from "@/i18n";

import type {
  CompanionSurfaceCardGrowth,
  CompanionSurfaceGrowth,
  CompanionSurfacePhase,
} from "@/components/companion-surface";

/**
 * The companion's one-time introduction, drawn on the companion itself.
 *
 * **It runs where the thing it describes is.** The surface is the only part of
 * this product that lives on the user's desktop rather than inside the app's
 * window, and it is there without the user having opened it. Explaining it in
 * the app window would put the explanation in the one place the user is not
 * looking when the surface matters, and would leave them reading a description
 * of a pill instead of looking at the pill. So the beats are drawn beside the
 * real surface, over whatever the user actually has on screen.
 *
 * **The avatar is the anchor, not the pill.** The pill changes width from beat
 * to beat as controls are spotlighted, and a card pinned to a box that is
 * animating would slide about while being read. The avatar holds one point in
 * the canvas in every state (see `CompanionSurface`), so the card hangs off
 * that instead and never moves for the whole run.
 *
 * **It costs the canvas nothing.** The window is already sized for the tallest
 * state the surface has, which is the typing card, and that height is reserved
 * on the `cardGrowth` side of the avatar. No beat of the introduction opens the
 * composer, so that whole region is free while the run is on, and the card is
 * drawn into it. Growing the window for the introduction would have meant
 * moving it, and moving it would have meant re-deciding growth and placement in
 * the main process for a card that is on screen once in an install's life.
 */

/** Gap between the avatar's edge and the card, in base layout points. */
const AVATAR_GAP = 12;

/** The avatar's box the layout is authored at, as `CompanionSurface` has it. */
const AVATAR_BOX = 44;

/**
 * The card's width, fixed rather than measured.
 *
 * Prose has no natural width, so measuring would size the card to whichever
 * beat happened to say the most and change its shape as the run advanced. This
 * is the same bargain the typing card makes, and it fits the canvas at every
 * size: the window reaches `maxPillWidth - avatarBox / 2` past the avatar in
 * both directions (`geometryFor` in `companion-window.ts`), which is 338 at the
 * size this layout is authored at.
 */
const CARD_WIDTH = 244;

/**
 * Where each beat's two lines live, by beat.
 *
 * Two short lines and no more. This is a panel floating over the app the user
 * was actually using, so every extra sentence is a sentence read at the expense
 * of the thing being pointed at, and the controls being introduced already
 * carry their own labels.
 *
 * A literal key per beat rather than a template built from the beat name: the
 * catalogs type `t()`, and a key assembled at runtime types as `string` and
 * checks against nothing, which is how a renamed beat becomes a card printing
 * its own key path at someone.
 *
 * **`talk` and `type` quote the pill.** Their titles are the labels on the two
 * controls the beat spotlights, so they are not free copy: when the surface
 * itself is translated (`companion-surface.tsx` is still English throughout),
 * these two titles move with the labels, in the same edit and to the same
 * words. A card reading "Hablar" beside a button reading "Talk" points at
 * nothing.
 */
const INTRO_COPY_KEYS = {
  meet: {
    title: "companionIntro.meet.title",
    body: "companionIntro.meet.body",
  },
  talk: {
    title: "companionIntro.talk.title",
    body: "companionIntro.talk.body",
  },
  type: {
    title: "companionIntro.type.title",
    body: "companionIntro.type.body",
  },
  menu: {
    title: "companionIntro.menu.title",
    body: "companionIntro.menu.body",
  },
} as const satisfies Record<
  CompanionIntroBeat,
  { title: string; body: string }
>;

/**
 * Which control the pill should draw as though the pointer were on it.
 *
 * Only the beats that name a control on the pill have one. `meet` is about the
 * creature, and `menu` is about a right-click on it, which no control on the
 * pill stands for. Shared with the page and the stories so a beat cannot be
 * introduced in one place and spotlighted in another.
 */
export const introSpotlight = (
  beat: CompanionIntroBeat | null,
): "talk" | "type" | undefined =>
  beat === "talk" || beat === "type" ? beat : undefined;

/**
 * The phase the surface holds while a beat is on screen, or `null` to leave the
 * phase to whatever the surface would otherwise be in.
 *
 * The control beats hold the pill open regardless of the pointer, the way a
 * call does, because a beat describing Talk with the pill shut is a beat
 * pointing at nothing. `meet` deliberately does not: the first thing the user is
 * shown is the resting circle, which is what the surface looks like for almost
 * all of its life, and the pill opening on the next beat is then something they
 * watch happen rather than a state they arrived in.
 */
export const introPhase = (
  beat: CompanionIntroBeat | null,
): CompanionSurfacePhase | null => {
  if (beat === null || beat === "meet") {
    return null;
  }
  return "hover";
};

export interface CompanionIntroProps {
  /** The beat being shown. The caller renders nothing when there is none. */
  beat: CompanionIntroBeat;
  /** Which side of the avatar the pill runs off, so the card runs the same way. */
  growth?: CompanionSurfaceGrowth;
  /** Which side of the avatar has the canvas to hold the card. */
  cardGrowth?: CompanionSurfaceCardGrowth;
  /** The assistant's avatar colour, for the progress dots. */
  accentHex?: string;
  /**
   * The assistant's own name, for the first beat.
   *
   * The creature introduces itself by name because it has one, and the surface
   * is the one place it appears without the app around it to say whose it is.
   * Undefined until the app's window has published a name, which is a real
   * state on a cold launch, and the beat falls back to naming no one rather
   * than to a gap in the sentence.
   */
  assistantName?: string;
  /**
   * The card's own element, for the host to hit-test the pointer against.
   *
   * The companion's window is click-through except where it is told otherwise,
   * and the card carries the only two controls in the run, so the page has to
   * know where it landed. Same reason `CompanionSurface` hands out `rootRef`.
   */
  cardRef?: Ref<HTMLDivElement>;
  /** Advance or end the run. Absent leaves the controls inert, which is what
   *  Storybook wants. */
  onAdvance?: (action: CompanionIntroAction) => void;
}

export function CompanionIntro({
  beat,
  growth = "right",
  cardGrowth = "up",
  accentHex,
  assistantName,
  cardRef,
  onAdvance,
}: CompanionIntroProps) {
  const { t } = useTranslation();
  const index = COMPANION_INTRO_BEATS.indexOf(beat);
  const isLast = index === COMPANION_INTRO_BEATS.length - 1;
  const copy = INTRO_COPY_KEYS[beat];

  // The pill's own horizontal anchoring, repeated rather than shared, because
  // the card is a sibling of the pill and not inside it: it must not inherit
  // the width that animates from beat to beat. Anchoring to the same edge is
  // what makes the card and the pill read as one object being annotated.
  const placement: CSSProperties =
    growth === "left"
      ? { right: "50%", marginRight: -(AVATAR_BOX / 2) }
      : { left: "50%", marginLeft: -(AVATAR_BOX / 2) };

  // The vertical half: sit against the canvas edge the avatar is near, then
  // step off the avatar by its own half box plus the gap. `100%` names the
  // canvas without this side having to know how tall the host made it, which is
  // the same trick the surface's own anchor uses.
  const anchor: CSSProperties =
    cardGrowth === "up"
      ? {
          top: `calc(100% - ${COMPANION_NEAR_EDGE}px)`,
          transform: `translateY(calc(-100% - ${AVATAR_BOX / 2 + AVATAR_GAP}px))`,
        }
      : {
          top: COMPANION_NEAR_EDGE,
          transform: `translateY(${AVATAR_BOX / 2 + AVATAR_GAP}px)`,
        };

  return (
    <div
      ref={cardRef}
      // Announced as a group rather than a dialog: it takes no focus and traps
      // none. The window is unfocusable at rest and the run is driven by the
      // pointer, so claiming a dialog's semantics would promise keyboard
      // behaviour this panel cannot deliver.
      role="group"
      aria-label={t("companionIntro.ariaLabel")}
      className="absolute flex flex-col gap-2 rounded-2xl border border-white/10 bg-[#17181b]/95 px-3.5 py-3 shadow-lg shadow-black/40"
      style={{ width: CARD_WIDTH, ...placement, ...anchor }}
      // The card is not a drag handle. Everything else on this surface is, and
      // a press that both read a sentence and flung the pill across the desktop
      // would be the one interaction here nobody could undo.
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
    >
      {/* Clamped, because the only variable in this card is a name the user
          chose and there is no length it has to be. The card's width is fixed
          and its height is borrowed from the canvas the typing card reserves,
          so a title free to wrap is a title free to grow the card past what it
          was drawn into. Two lines holds every name worth reading. */}
      <p className="line-clamp-2 text-[13px] leading-tight font-medium text-white">
        {/* The first beat is the introduction proper, so it is the one that
            says the name. Two keys rather than one with an empty argument: a
            sentence built around a name that is not there reads as a bug, and
            the unnamed version is a different sentence rather than the same one
            with a hole in it. */}
        {beat === "meet" && assistantName !== undefined
          ? t("companionIntro.meet.titleNamed", { name: assistantName })
          : t(copy.title)}
      </p>
      <p className="text-[12px] leading-[1.45] text-white/70">{t(copy.body)}</p>
      <div className="flex items-center justify-between pt-0.5">
        {/* Where the run is, as dots rather than "2 of 3". The count is not
            information anyone acts on; that it is nearly over is. */}
        <div className="flex items-center gap-1" aria-hidden>
          {COMPANION_INTRO_BEATS.map((each, at) => (
            <span
              key={each}
              className="size-1.5 rounded-full transition-colors"
              style={{
                backgroundColor:
                  at === index
                    ? (accentHex ?? "#5eead4")
                    : "rgba(255,255,255,.2)",
              }}
            />
          ))}
        </div>
        <div className="flex items-center gap-1">
          {/* Skip is offered only while there is something left to skip. On the
              last beat the primary control already ends the run, and two
              buttons that do the same thing is a choice the user has to stop
              and read. */}
          {!isLast && (
            <button
              type="button"
              className="h-7 rounded-full px-2.5 text-[12px] text-white/55 transition-colors hover:bg-white/10 hover:text-white/80"
              onClick={() => onAdvance?.("dismiss")}
            >
              {t("companionIntro.skip")}
            </button>
          )}
          <button
            type="button"
            className="h-7 rounded-full bg-white/15 px-3 text-[12px] text-white transition-colors hover:bg-white/25"
            onClick={() => onAdvance?.("next")}
          >
            {isLast ? t("companionIntro.done") : t("companionIntro.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
