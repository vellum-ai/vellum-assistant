import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_INTRO_BEATS,
} from "@vellumai/ipc-contract";
import type {
  CompanionIntroAction,
  CompanionIntroBeat,
} from "@vellumai/ipc-contract";
import type { VoiceActivityState } from "@vellumai/ipc-contract";
import type { CSSProperties, Ref } from "react";

import { useTranslation } from "@/i18n";

import { companionLayoutFor } from "@/components/companion-layout";
import { useAvatarPerch } from "@/components/companion-surface";
import type {
  CompanionSurfaceCardGrowth,
  CompanionSurfaceGrowth,
  CompanionSurfacePhase,
  CompanionSurfaceSpotlight,
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
 * **It costs the canvas nothing.** The window already reserves a card's height
 * on the `cardGrowth` side of the avatar (`COMPANION_BASE_CARD_HEIGHT`), and
 * nothing else draws into that region, so the card is drawn there. Growing the
 * window for the introduction would have meant moving it, and moving it would
 * have meant re-deciding growth and placement in the main process for a card
 * that is on screen once in an install's life.
 */

/**
 * The card's width, fixed rather than measured.
 *
 * Prose has no natural width, so measuring would size the card to whichever
 * beat happened to say the most and change its shape as the run advanced. It
 * fits the canvas at every size, which main sizes by its own `maxReach`
 * (`geometryFor` in `companion-window.ts`).
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
 * **`talk` quotes the pill.** Its title is the label on the control the beat
 * spotlights, so it is not free copy: it moves with that label, in the same
 * edit and to the same words. A card reading "Hablar" beside a button reading
 * "Talk" points at nothing.
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
  share: {
    title: "companionIntro.share.title",
    body: "companionIntro.share.body",
  },
  draw: {
    title: "companionIntro.draw.title",
    body: "companionIntro.draw.body",
  },
  mute: {
    title: "companionIntro.mute.title",
    body: "companionIntro.mute.body",
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
/**
 * Which control on the pill the beat is about, drawn as though the pointer
 * were on it: its name and its key are revealed, so the sentence on the card
 * has the thing it names lit beside it.
 *
 * One beat, one control. A beat that lit two would be a beat about two things,
 * and the run exists to take them one at a time.
 */
export const introSpotlight = (
  beat: CompanionIntroBeat | null,
): CompanionSurfaceSpotlight | undefined => {
  switch (beat) {
    case "talk":
    case "share":
    case "draw":
    case "mute":
      return beat;
    default:
      return undefined;
  }
};

/**
 * The session the `controls` beat draws the pill around: a call that is not
 * happening.
 *
 * The controls worth pointing out are the call's, and they exist nowhere else
 * on this surface. Asking the user to start a session to be shown the session
 * controls is the wrong way round, so the beat borrows the shape: the pill is
 * drawn as the bar a call builds, with nothing behind it and nothing it can be
 * pressed to do.
 *
 * Listening rather than idle, because that is the state a call spends its time
 * in and the one the bar is designed to read as. Nothing about it reaches a
 * session: the caller passes it to the surface and withholds the handlers, so
 * every control on it is drawn and inert (see `companion-surface-page.tsx`).
 */
export const introDemoCall = (label: string): VoiceActivityState => ({
  phase: "listening",
  // What the bar says it is doing. Passed in rather than fixed here because it
  // is copy, and copy belongs in a catalog: the caller reads it from theirs.
  label,
  accentHex: "",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
  assistantName: "",
});

/** The keys the call beats name, as the host arms them. */
export const INTRO_DEMO_SHORTCUTS = {
  share: "⌥S",
  draw: "⌥D",
  muteMicrophone: "⌥M",
  muteAssistant: "⌥A",
} as const;

/**
 * The key the beat's own control answers, or undefined for a beat about
 * something no key reaches.
 *
 * On the card rather than in a caption beside the control: the card is already
 * naming that control and pointing at it, and a caption in between would be
 * the same word again with the beak running through it.
 */
const BEAT_SHORTCUTS: Partial<Record<CompanionIntroBeat, string>> = {
  share: INTRO_DEMO_SHORTCUTS.share,
  draw: INTRO_DEMO_SHORTCUTS.draw,
  mute: INTRO_DEMO_SHORTCUTS.muteMicrophone,
};

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
  // The beats about the call's controls are drawn as a call, which is the only
  // state those controls exist in. See {@link introDemoCall}.
  if (beat === "share" || beat === "draw" || beat === "mute") {
    return "call";
  }
  return "hover";
};

/**
 * The session the call beats draw the pill around, and how much of one each
 * needs, or `null` on a beat that is not about a call.
 *
 * Share is offered on any call, so the first of the three is a call with
 * nothing being shown yet. Draw exists only while something is: it acts on the
 * shared surface, and before there is one it is not a control that is
 * unavailable, it is a control that is not there. So the demonstration starts
 * showing the screen from that beat on, which is also the order the real thing
 * happens in: show, then draw on what is shown.
 *
 * One table, read by the surface's own page and by the stories, so a beat
 * cannot be introduced in one and drawn differently in the other.
 */
export const introDemoState = (
  beat: CompanionIntroBeat | null,
  label: string,
): { call: VoiceActivityState; sharing: boolean } | null => {
  if (beat !== "share" && beat !== "draw" && beat !== "mute") {
    return null;
  }
  return { call: introDemoCall(label), sharing: beat !== "share" };
};

export interface CompanionIntroProps {
  /** The beat being shown. The caller renders nothing when there is none. */
  beat: CompanionIntroBeat;
  /** Which side of the avatar the pill runs off, so the card runs the same way. */
  growth?: CompanionSurfaceGrowth;
  /** Which side of the avatar has the canvas to hold the card. */
  cardGrowth?: CompanionSurfaceCardGrowth;
  /**
   * The creature's box and the pill's, in points, as `CompanionSurface` takes
   * them.
   *
   * The card hangs off the creature and has to clear whatever the pill draws
   * beside it, so it needs the same two numbers the surface does. Defaulted to
   * the size the layout is authored at, which is what Storybook draws.
   */
  avatarBox?: number;
  optionsBox?: number;
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
  /**
   * Whether the desktop may already be shown to a call, which decides whether
   * the share beat asks for the permission or moves on. Undefined where the
   * answer is not known, which reads as nothing to ask for: a card that
   * offered to fix a permission it cannot see is worse than one that stays
   * quiet.
   */
  screenGranted?: boolean;
  /** Raise the system's screen-recording prompt. Absent offers no Allow. */
  onGrantScreen?: () => void;
}

export function CompanionIntro({
  beat,
  growth = "right",
  cardGrowth = "up",
  avatarBox = COMPANION_BASE_AVATAR_BOX,
  optionsBox = COMPANION_BASE_AVATAR_BOX,
  accentHex,
  assistantName,
  cardRef,
  onAdvance,
  screenGranted,
  onGrantScreen,
}: CompanionIntroProps) {
  const { t } = useTranslation();
  const index = COMPANION_INTRO_BEATS.indexOf(beat);
  const isLast = index === COMPANION_INTRO_BEATS.length - 1;
  const copy = INTRO_COPY_KEYS[beat];
  // The one beat with a permission to ask for, and only while it is missing
  // and there is something here able to ask.
  const asking =
    beat === "share" && screenGranted === false && onGrantScreen !== undefined;

  // Where the creature is standing, when a beat has walked it over a control.
  // The card hangs off the creature, so this is all it needs to travel with
  // it. See `AvatarPerchContext`.
  const perch = useAvatarPerch();

  // The same derivation `CompanionSurface` places the pill by, so the card and
  // the pill are arranged around one creature rather than two readings of it.
  const { inUnits, avatarHalf, lineAt, edgeAt, introStepOff } =
    companionLayoutFor(avatarBox, optionsBox);
  // Clears whichever of the creature and the pill reaches further on this side,
  // and then the gap. Stepping off the creature alone would put the card inside
  // a pill taller than it, since the pill stands on the creature's baseline
  // rather than being centred on it and every beat but `meet` holds it open.
  const stepOff = inUnits(introStepOff(cardGrowth));

  // Hung off the avatar's own edge, which is the point the host positioned this
  // window around and the point the pill is measured from too. Not off the
  // pill: that box changes width from beat to beat as controls are spotlighted,
  // and a card pinned to it would slide about while being read.
  const placement: CSSProperties =
    perch === null
      ? edgeAt(growth, -avatarHalf)
      : // Centred over the creature rather than hung off its side: it is
        // standing on the control the beat is about, so the card belongs
        // above that control too.
        { left: perch };

  // The vertical half: sit on the avatar's own line, then step off it far
  // enough to clear what is drawn there.
  const anchor: CSSProperties = {
    top:
      perch === null
        ? lineAt(cardGrowth, 0)
        : `calc(${lineAt(cardGrowth, 0)} - ${stepOff}px)`,
    transform: [
      perch === null ? null : "translateX(-50%)",
      cardGrowth === "up"
        ? `translateY(calc(-100% - ${stepOff}px))`
        : `translateY(${stepOff}px)`,
    ]
      .filter((part) => part !== null)
      .join(" "),
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
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {/* Clamped, because the only variable in this card is a name the user
          chose and there is no length it has to be. The card's width is fixed
          and its height is borrowed from the canvas main reserves for it, so a
          title free to wrap is a title free to grow the card past what it was
          drawn into. Two lines holds every name worth reading. */}
      <p className="flex items-center gap-1.5 text-[13px] leading-tight font-medium text-white">
        {/* The first beat is the introduction proper, so it is the one that
            says the name. Two keys rather than one with an empty argument: a
            sentence built around a name that is not there reads as a bug, and
            the unnamed version is a different sentence rather than the same one
            with a hole in it. */}
        <span className="line-clamp-2">
          {beat === "meet" && assistantName !== undefined
            ? t("companionIntro.meet.titleNamed", { name: assistantName })
            : t(copy.title)}
        </span>
        {BEAT_SHORTCUTS[beat] === undefined ? null : (
          <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-normal text-white/70">
            {BEAT_SHORTCUTS[beat]}
          </span>
        )}
      </p>
      <p className="text-[12px] leading-[1.45] text-white/70">{t(copy.body)}</p>
      {/* **The permission is asked for where it is explained.** The beat
          pointing at Share is the one moment the user has a reason to grant
          screen recording, so the ask is here rather than at some later moment
          they would have to connect back to this.
          Beside the sentence and not in place of Next: an Allow that took the
          primary control's spot made the first press on that spot do something
          other than move on, which reads as a Next that did not work. */}
      {asking && (
        <button
          type="button"
          className="self-start rounded-full bg-white/15 px-2.5 py-1 text-[12px] text-white transition-colors hover:bg-white/25"
          onClick={onGrantScreen}
        >
          {t("companionIntro.share.allow")}
        </button>
      )}
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
          {/* Skip is offered only while there is something left to skip. On
              the last beat the primary control already ends the run, and two
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
