import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_INTRO_BEATS,
} from "@vellumai/ipc-contract";
import type {
  CompanionIntroAction,
  CompanionIntroBeat,
} from "@vellumai/ipc-contract";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";

import { useTranslation } from "@/i18n";
import { askForInputMonitoring } from "@/utils/input-monitoring-ask";
import { modifierLabel } from "@/utils/ptt-activator";
import { useVoiceKey } from "@/utils/voice-key";
import { createVoiceKeyArrivalDetector } from "@/utils/voice-key-arrival";

import { CompanionIntroHoldHelp } from "@/components/companion-intro-hold-help";
import { companionLayoutFor } from "@/components/companion-layout";
import { InputMonitoringReason } from "@/components/input-monitoring-reason";
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
 *
 * **`hold` names the key.** Its title carries the label of whatever key the
 * user has the voice bound to, Fn out of the box, and it has a second reading
 * for when the wait runs out (see `CompanionIntroHoldHelp`).
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
  hold: {
    title: "companionIntro.hold.title",
    body: "companionIntro.hold.body",
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
): "talk" | undefined => (beat === "talk" ? beat : undefined);

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

/**
 * Where the hold beat stands: macOS being asked for Input Monitoring, the key
 * being waited on, or the wait run out with nothing arriving.
 */
type HoldPhase = "asking" | "waiting" | "unreached";

/**
 * The hold beat's own side of proof by doing.
 *
 * The edge lands elsewhere: the app's window owns the key, reports the edge
 * to main as `holdProven`, and main moves the beat on and pushes the new one
 * down, which is how an arrival reaches this surface. So there is no press to
 * feed the detector here, and what it is armed for is the other outcome: the
 * wait running out, which is the cue to say the key never reached the app.
 *
 * Before the wait, the ask. The helper cannot see the key without Input
 * Monitoring, and the system prompt names the app and nothing else, so the
 * question is put here, beside the reason for it, right before the user is
 * asked to hold the key. A refusal skips the wait, since no edge can come; a
 * host with no permissions to ask for has no helper, and the beat is walked
 * past the way it is for a key set to Off.
 */
function useHoldProof({
  active,
  onWalkPast,
}: {
  active: boolean;
  onWalkPast: () => void;
}): { phase: HoldPhase; tryAgain: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<HoldPhase>("asking");
  // Read at the moment it is needed rather than depended on: the caller's
  // handler is not what starts the wait over.
  const walkPast = useRef(onWalkPast);
  useEffect(() => {
    walkPast.current = onWalkPast;
  }, [onWalkPast]);

  useEffect(() => {
    if (!active) {
      return;
    }
    let stale = false;
    const detector = createVoiceKeyArrivalDetector({
      onOutcome: (outcome) => {
        if (outcome === "neverArrived") {
          setPhase("unreached");
        }
      },
    });
    void askForInputMonitoring().then((status) => {
      if (stale) {
        return;
      }
      if (status === null) {
        walkPast.current();
        return;
      }
      if (status === "granted") {
        setPhase("waiting");
        detector.arm();
        return;
      }
      setPhase("unreached");
    });
    return () => {
      stale = true;
      detector.cancel();
    };
  }, [active, attempt]);

  const tryAgain = useCallback(() => {
    setPhase("asking");
    setAttempt((count) => count + 1);
  }, []);

  return { phase, tryAgain };
}

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
}: CompanionIntroProps) {
  const { t } = useTranslation();
  const index = COMPANION_INTRO_BEATS.indexOf(beat);
  const isLast = index === COMPANION_INTRO_BEATS.length - 1;
  const copy = INTRO_COPY_KEYS[beat];

  // The `hold` beat is proof by doing: it has no Next, and is walked past only
  // when a real edge of the voice key reaches the app's window, which reports
  // it to main (see `useCompanionIntroHoldProof`). What this side holds is the
  // ask, the wait, and the reading the card takes once the wait runs out.
  const voiceKey = useVoiceKey();
  const asksForHold = beat === "hold" && voiceKey.kind !== "off";
  // A host with no helper is walked past the way a key set to Off is, below:
  // nothing there could prove the key. Main resolves the press against its
  // own beat, so a stale one cannot walk anything else.
  const walkPast = useCallback(() => {
    onAdvance?.("next");
  }, [onAdvance]);
  const { phase, tryAgain } = useHoldProof({
    active: asksForHold,
    onWalkPast: walkPast,
  });
  const unproven = asksForHold && phase === "unreached";
  // A key switched off has nothing to prove and nothing that could prove it,
  // so the beat is walked past rather than waited on.
  useEffect(() => {
    if (beat === "hold" && voiceKey.kind === "off") {
      onAdvance?.("next");
    }
  }, [beat, voiceKey.kind, onAdvance]);
  const keyLabel =
    voiceKey.kind === "off" ? "" : modifierLabel(voiceKey.modifiers);

  const title = (): string => {
    // The first beat is the introduction proper, so it is the one that says
    // the name. Two keys rather than one with an empty argument: a sentence
    // built around a name that is not there reads as a bug, and the unnamed
    // version is a different sentence rather than the same one with a hole in
    // it.
    if (beat === "meet" && assistantName !== undefined) {
      return t("companionIntro.meet.titleNamed", { name: assistantName });
    }
    if (beat === "hold") {
      return unproven
        ? t("companionIntro.hold.unreachedTitle", { key: keyLabel })
        : t("companionIntro.hold.title", { key: keyLabel });
    }
    return t(copy.title);
  };

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
  const placement: CSSProperties = edgeAt(growth, -avatarHalf);

  // The vertical half: sit on the avatar's own line, then step off it far
  // enough to clear what is drawn there.
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
      <p className="line-clamp-2 text-[13px] leading-tight font-medium text-white">
        {title()}
      </p>
      {unproven ? (
        <CompanionIntroHoldHelp />
      ) : asksForHold && phase === "asking" ? (
        // The reason for the prompt macOS is about to show, in place of the
        // invitation: a hold before the grant reaches nothing. Draws nothing
        // once the grant is given, which lasts the one round trip that reads
        // it.
        <InputMonitoringReason className="text-[12px] leading-[1.45] text-white/70" />
      ) : (
        <p className="text-[12px] leading-[1.45] text-white/70">
          {t(copy.body)}
        </p>
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
          {/* The hold beat has no Next: the key is the way past it. What it
              offers instead, once the wait has run out, is another wait. */}
          {beat === "hold" ? (
            unproven && (
              <button
                type="button"
                className="h-7 rounded-full bg-white/15 px-3 text-[12px] text-white transition-colors hover:bg-white/25"
                onClick={tryAgain}
              >
                {t("companionIntro.hold.tryAgain")}
              </button>
            )
          ) : (
            <button
              type="button"
              className="h-7 rounded-full bg-white/15 px-3 text-[12px] text-white transition-colors hover:bg-white/25"
              onClick={() => onAdvance?.("next")}
            >
              {isLast ? t("companionIntro.done") : t("companionIntro.next")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
