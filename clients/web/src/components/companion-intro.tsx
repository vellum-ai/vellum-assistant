import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_INTRO_BEAT_GROUPS,
  COMPANION_INTRO_BEATS,
  COMPANION_INTRO_GROUPS,
  COMPANION_INTRO_CARD_WIDTH,
  COMPANION_INTRO_CARD_HEIGHT,
  COMPANION_INTRO_PERCH_GAP,
  COMPANION_PERCH_HOP,
  companionIntroCallControlFor,
} from "@vellumai/ipc-contract";
import type {
  CompanionIntroAction,
  CompanionIntroBeat,
  CompanionIntroCallControl,
} from "@vellumai/ipc-contract";
import type { VoiceActivityState } from "@vellumai/ipc-contract";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";

import { Globe, Mic, Pencil, ScreenShare, X } from "lucide-react";

import { useTranslation } from "@/i18n";
import { CompanionIntroPermission } from "./companion-intro-permission";
import {
  companionIntroNeedsPermission,
  type CompanionIntroPermission as IntroPermission,
} from "./use-companion-intro-permission";

import { companionLayoutFor } from "@/components/companion-layout";
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
 * How long the card holds its answer to a pointer pressing the drawn key.
 *
 * Long enough to be read and to land as a joke, short enough that the card goes
 * back to saying what to actually do while the hand is still hovering over it.
 */
const SCOLD_MS = 3_000;

/**
 * Where each beat's lines live, by beat.
 *
 * Short lines and few. This is a panel floating over the app the user was
 * actually using, so every extra sentence is a sentence read at the expense of
 * the thing being pointed at, and the controls being introduced already carry
 * their own labels.
 *
 * A literal key per beat rather than a template built from the beat name: the
 * catalogs type `t()`, and a key assembled at runtime types as `string` and
 * checks against nothing, which is how a renamed beat becomes a card printing
 * its own key path at someone.
 *
 * `meet` keeps the greeting `idle` opens with. `key` carries no body, since
 * its instruction is a picture of a key and the line above it.
 *
 * `titleNamed` is the version for an assistant whose name this window has been
 * told. Two keys rather than one with an empty argument: a sentence built
 * around a name that is not there reads as a bug, and the unnamed version is a
 * different sentence rather than the same one with a hole in it.
 */
const INTRO_COPY_KEYS = {
  idle: {
    title: "companionIntro.idle.title",
    titleNamed: "companionIntro.idle.titleNamed",
    body: "companionIntro.idle.body",
  },
  meet: {
    title: "companionIntro.idle.title",
    titleNamed: "companionIntro.idle.titleNamed",
    body: "companionIntro.meet.body",
  },
  talk: {
    title: "companionIntro.talk.title",
    body: "companionIntro.talk.body",
  },
  key: {
    title: "companionIntro.key.title",
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
  try: {
    title: "companionIntro.try.title",
    body: "companionIntro.try.body",
  },
} as const satisfies Record<
  CompanionIntroBeat,
  { title: string; titleNamed?: string; body?: string }
>;

/**
 * Which control on the pill the beat is about, drawn as though the pointer were
 * on it: its name and its key are revealed and the rest of the bar dims, so the
 * sentence on the card has the one thing it names lit beside it.
 *
 * One beat, one control, which is why each of the call's three has a beat. The
 * rest have none: `idle` and `meet` are the surface itself, and the Talk beats
 * and the closing offer point at the creature by walking it into the card
 * instead.
 *
 * Which beats those are is {@link companionIntroCallControlFor}'s to say, so
 * the button lit on the bar, the key armed on the keyboard and the chip drawn
 * on the card are one answer read three times. This is that answer under the
 * name the surface reads it by.
 */
export const introSpotlight = (
  beat: CompanionIntroBeat | null,
): CompanionSurfaceSpotlight | undefined => companionIntroCallControlFor(beat);

/**
 * The session the `call` beat draws the pill around: a call that is not
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

/** The keys the call beat names, as the host arms them. */
export const INTRO_DEMO_SHORTCUTS = {
  share: "⌥S",
  draw: "⌥D",
  muteMicrophone: "⌥M",
  muteAssistant: "⌥A",
} as const;

/**
 * The control a beat is about, drawn on the card: its own icon and the key that
 * reaches it.
 *
 * The icon is the pill's own, which is what lets the card be matched to the
 * button it is describing without reading either: the beat lights that button
 * on the bar, and the same mark is on the card pointing at it.
 *
 * The key is here rather than in a caption on the control itself, because the
 * card is already naming that control and a caption in between would be the
 * same word again with a beak through it.
 *
 * **One row per control the contract names, and the compiler checks it.** A
 * `ReactNode` cannot live in the contract, so this table has to stay here; what
 * must not stay here is which controls exist. Typed as the whole of
 * {@link CompanionIntroCallControl} rather than as some of the beats, so a
 * control added to the contract without a mark and a key on this card is a
 * typecheck failure rather than a card that draws nothing where its chip goes.
 */
const BEAT_CONTROLS = {
  share: {
    icon: <ScreenShare className="size-5" />,
    shortcut: INTRO_DEMO_SHORTCUTS.share,
  },
  draw: {
    icon: <Pencil className="size-5" />,
    shortcut: INTRO_DEMO_SHORTCUTS.draw,
  },
  mute: {
    icon: <Mic className="size-5" />,
    shortcut: INTRO_DEMO_SHORTCUTS.muteMicrophone,
  },
} as const satisfies Record<
  CompanionIntroCallControl,
  { icon: ReactNode; shortcut: string }
>;

/**
 * The phase the surface holds while a beat is on screen, or `null` to leave the
 * phase to whatever the surface would otherwise be in.
 *
 * The beats about the call's controls are drawn as a call, which is the only
 * state those controls exist in.
 *
 * The rest leave the surface as it is, which at rest is the creature and
 * nothing else. That is what the surface looks like for almost all of its life,
 * and it is what the Talk beats want: they call the creature into the card and
 * ask for a click on it, and a pill unfurled beside an empty spot the creature
 * has just left would be the one thing on screen pointing nowhere.
 */
export const introPhase = (
  beat: CompanionIntroBeat | null,
): CompanionSurfacePhase | null =>
  introSpotlight(beat) === undefined ? null : "call";

/**
 * The session the call's beats draw the pill around, and how much of one each
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
): { call: VoiceActivityState; sharing: boolean } | null =>
  introSpotlight(beat) === undefined
    ? null
    : { call: introDemoCall(label), sharing: beat !== "share" };

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
  permission?: IntroPermission | null;
  /**
   * Whether the creature staged in this card has been clicked.
   *
   * The Talk beat asks for a click and the click is taken by the creature,
   * which belongs to the surface, so the card cannot see it happen: the caller
   * says it did. A click here starts no session on purpose (the user is being
   * shown how, not put in a call they did not ask for), so the answer has to be
   * on the card or the press reads as having done nothing.
   */
  greeted?: boolean;
  /**
   * How many times the real voice key has been tapped, counted by the window
   * that owns the binding for as long as a run is up.
   *
   * The key's edges reach only that window, so the beats that draw the key
   * cannot see it being pressed and are told instead. A running total rather
   * than a flag, which is what lets a second tap be told from the first and
   * both from a re-render (see `CompanionSurfaceState.voiceKeyTaps`); what this
   * card cares about is how much of it arrived while the beat was up.
   */
  voiceKeyTaps?: number;
  /**
   * How many of the call's shortcuts have been pressed while a run was asking
   * for one, counted by the window that armed the binding, and which control
   * the last of them was for.
   *
   * The other half of {@link voiceKeyTaps}, for the three beats that draw a
   * call control beside its chord: those presses reach only that window, so
   * this card is told about them rather than seeing them. A running count for
   * the reason the taps are one, and the control beside it because a count
   * alone cannot say which card it answers (see
   * `CompanionSurfaceState.introChordControl`).
   */
  chordPresses?: number;
  chordControl?: CompanionIntroCallControl;
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
  permission = null,
  greeted = false,
  voiceKeyTaps = 0,
  chordPresses = 0,
  chordControl,
}: CompanionIntroProps) {
  const { t } = useTranslation();
  const index = COMPANION_INTRO_BEATS.indexOf(beat);
  const isLast = index === COMPANION_INTRO_BEATS.length - 1;
  const isFirst = index <= 0;
  const copy = INTRO_COPY_KEYS[beat];
  const needsPermission = companionIntroNeedsPermission(permission);
  const checkingPermission = permission?.state.phase === "checking";
  /** Which subject the run is in, which is what the dots draw. */
  const group = COMPANION_INTRO_BEAT_GROUPS[beat];
  /** The control on the pill this beat is about, where it is about one. */
  const controlOfBeat = companionIntroCallControlFor(beat);
  const control: { icon: ReactNode; shortcut: string } | undefined =
    controlOfBeat === undefined ? undefined : BEAT_CONTROLS[controlOfBeat];
  /**
   * Whether the drawn keycap has been clicked with the pointer, which is the
   * one thing on that beat the user can do that the beat is not asking for.
   *
   * Local, because nothing outside this card needs to know: no session starts,
   * no permission is asked for, and main's position in the run does not move.
   * It clears itself after a moment, so the card goes back to saying what to do
   * rather than holding a joke at somebody who has already got the point, and
   * it clears at once on a change of beat.
   */
  const [scolded, setScolded] = useState(false);
  useEffect(() => {
    setScolded(false);
  }, [beat]);
  useEffect(() => {
    if (!scolded) {
      return;
    }
    const timer = setTimeout(() => {
      setScolded(false);
    }, SCOLD_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [scolded]);
  /**
   * The real key takes the scold down.
   *
   * The scold is an answer to a hand in the wrong place, and a user whose hand
   * has just found the right one has stopped needing it: the cap would
   * otherwise be leaning away from a press while lighting up for it, which is
   * the card arguing with itself. The words go back to the instruction at the
   * same moment, which is where the reader's eye already is.
   */
  useEffect(() => {
    setScolded(false);
  }, [voiceKeyTaps]);
  /**
   * How much of that count landed while this beat has been up, capped at the
   * two presses the cap has a look for.
   *
   * Counted from the beat rather than taken raw, because the total outlives the
   * beat: the presses that answered the last beat are still in it, and so are
   * the ones that answered an earlier run of the introduction, which the count
   * carries forward rather than resetting between. A beat that opened already
   * lit would be answering a press nobody has made on it.
   *
   * The baseline is taken during the render that notices the beat change rather
   * than in an effect after it, so the new beat's first paint is the dark cap
   * instead of the old beat's reading corrected a frame later.
   */
  const [tapsBeforeBeat, setTapsBeforeBeat] = useState(voiceKeyTaps);
  // The same, for the chord the call beats ask for. One sentinel for both,
  // because it is one fact: the beat changed, so everything counted from the
  // beat starts again from here.
  const [chordsBeforeBeat, setChordsBeforeBeat] = useState(chordPresses);
  const [beatOfCounts, setBeatOfCounts] = useState<CompanionIntroBeat>(beat);
  if (beatOfCounts !== beat) {
    setBeatOfCounts(beat);
    setTapsBeforeBeat(voiceKeyTaps);
    setChordsBeforeBeat(chordPresses);
  } else if (voiceKeyTaps < tapsBeforeBeat) {
    // **The count went backwards, so it is a different count.** It belongs to
    // another window's store, which starts again at zero when that window
    // reloads, and this card can outlive one: the beat is main's and the
    // surface holds it across the app window coming and going. A baseline left
    // where it was would be measuring the new count against the old one's
    // total, and every press until it caught up would land on a cap that never
    // lit. Following it down costs nothing, since a count that fell has no
    // presses of this beat's left in it either way.
    setTapsBeforeBeat(voiceKeyTaps);
  }
  // Floored as well as capped, for the render that notices either of the two
  // resets above and still holds the baseline they are replacing.
  const taps = Math.min(Math.max(voiceKeyTaps - tapsBeforeBeat, 0), 2);
  if (chordPresses < chordsBeforeBeat) {
    // The count went backwards, so it is another window's count. The same
    // reading, and the same repair, as the taps above.
    setChordsBeforeBeat(chordPresses);
  }
  /**
   * Whether the shortcut this beat draws has been pressed on this beat.
   *
   * **Both halves are load-bearing.** The count says a press happened and the
   * control says which chord it was: a press made on the beat before, still
   * crossing when the run walked on, arrives here as a step in the count that
   * belongs to a different card, and lighting this chip with it would be
   * answering a key nobody pressed on this one. The beats are named after
   * their controls, so the address is the beat.
   *
   * One press rather than two. The cap asks for a double tap and has a look
   * per press; a chord is one press and is either made or not.
   */
  const shortcutPressed =
    controlOfBeat !== undefined &&
    chordControl === controlOfBeat &&
    chordPresses > chordsBeforeBeat;

  // The same derivation `CompanionSurface` places the pill by, so the card and
  // the pill are arranged around one creature rather than two readings of it.
  const { inUnits, avatarHalf, gap, lineAt, edgeAt, introStepOff } =
    companionLayoutFor(avatarBox, optionsBox);
  // Clears whichever of the creature and the pill reaches further on this side,
  // and then the gap. Stepping off the creature alone would put the card inside
  // a pill taller than it, since the pill stands on the creature's baseline
  // rather than being centred on it and every beat but `meet` holds it open.
  //
  // **On the beats that walk it, the creature itself stands on this side.** It
  // hops up onto the control the beat is about, which puts its whole box above
  // the pill, and a card placed for the pill alone lands on top of it. So those
  // beats clear where it stands and leave a gap over it: the walk is worth
  // watching, which it is not from under a panel.
  //
  // Only those beats. The distance is another 28 units at the authored size and
  // more at every size above it, and holding the opening cards that far off a
  // creature with nothing between them is what made them look stranded up the
  // canvas, reserving room for a beat three presses away.
  const stepOff =
    cardGrowth === "down" || introSpotlight(beat) === undefined
      ? inUnits(introStepOff(cardGrowth))
      : inUnits(avatarHalf + gap) +
        COMPANION_PERCH_HOP +
        inUnits(avatarHalf) +
        COMPANION_INTRO_PERCH_GAP;

  // Hung off the avatar's own edge, which is the point the host positioned this
  // window around and the point the pill is measured from too.
  //
  // **Not off whatever the creature is doing.** The creature walks to the
  // control a beat is about and into the card on the Talk beat, and the pill
  // changes width as controls are spotlighted; a card pinned to either would
  // slide about while it was being read. One position for the whole run, which
  // is the only way a reader keeps their place in it.
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
      className="absolute flex flex-col rounded-2xl border border-white/10 bg-[#17181b]/95 p-5 shadow-lg shadow-black/40"
      style={{
        width: COMPANION_INTRO_CARD_WIDTH,
        height: COMPANION_INTRO_CARD_HEIGHT,
        ...placement,
        ...anchor,
      }}
      // The card is not a drag handle. Everything else on this surface is, and
      // a press that both read a sentence and flung the pill across the desktop
      // would be the one interaction here nobody could undo.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {/* The way out, in the corner every panel keeps one in rather than as a
          word beside the primary control: it is the same affordance on every
          beat, including the last, and one that does not have to be read. */}
      <button
        type="button"
        aria-label={t("companionIntro.close")}
        className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-white/10 hover:text-white/80"
        onClick={() => onAdvance?.("dismiss")}
      >
        <X className="size-3.5" />
      </button>
      {/* What the beat says, in the room left over once the footer has taken
          its row. Top aligned rather than spread, so the title holds one line
          on every beat while the shortest beat simply leaves canvas empty
          underneath: a card that centred its contents would move every line in
          it on every press. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* Clamped, because the only variable in this card is a name the user
            chose and there is no length it has to be. The card's box is fixed,
            so a title free to wrap is a title free to push the rest of the beat
            out of it. Two lines holds every name worth reading. */}
        <p className="pr-6 text-[16px] leading-tight font-medium text-white">
          {/* The cards that greet say the name, where this window has been
              told one. See {@link INTRO_COPY_KEYS}. */}
          <span className="line-clamp-2">
            {"titleNamed" in copy && assistantName !== undefined
              ? t(copy.titleNamed, { name: assistantName })
              : t(copy.title)}
          </span>
        </p>
        {checkingPermission ? null : needsPermission && permission !== null ? (
          <CompanionIntroPermission permission={permission} />
        ) : (
          <>
            {"body" in copy ? (
              <p className="text-[14px] leading-[1.45] text-white/70">
                {beat === "talk" && greeted
                  ? t("companionIntro.talk.greeted")
                  : t(copy.body)}
              </p>
            ) : null}
            {/* The surface moves the real avatar onto this marker. */}
            {beat === "talk" && (
              <div className="flex flex-1 items-center justify-center">
                <span data-avatar-stage className="block size-11" aria-hidden />
              </div>
            )}
            {beat === "key" && (
              <>
                <p className="text-[14px] leading-[1.45] text-white/70">
                  {scolded
                    ? t("companionIntro.key.scolded")
                    : t("companionIntro.talk.gesture")}
                </p>
                <div className="flex flex-1 items-center justify-center">
                  <Keycap
                    label="fn"
                    taps={taps}
                    scolded={scolded}
                    take={() => {
                      setScolded(true);
                    }}
                  />
                </div>
              </>
            )}
            {beat === "try" && (
              <>
                <div className="flex flex-1 items-center justify-center gap-3">
                  <span
                    data-avatar-stage
                    className="block size-11"
                    aria-hidden
                  />
                  <Keycap
                    label="fn"
                    taps={taps}
                    scolded={scolded}
                    take={() => {
                      setScolded(true);
                    }}
                  />
                </div>
                <p className="text-center text-[11px] leading-tight text-white/45">
                  {scolded
                    ? t("companionIntro.key.scolded")
                    : t("companionIntro.try.how")}
                </p>
              </>
            )}
            {control !== undefined && (
              <div className="flex flex-1 items-center justify-center gap-4">
                <div className="flex flex-col items-center gap-1.5">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-white/10 text-white/85">
                    {control.icon}
                  </span>
                  <span className="text-[10px] leading-none text-white/40">
                    {t("companionIntro.call.click")}
                  </span>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <span
                    className={`flex h-10 items-center rounded-xl border px-3 text-[13px] font-medium transition-colors ${
                      shortcutPressed
                        ? "border-emerald-300/90 bg-emerald-400/55 text-emerald-50"
                        : "border-white/15 bg-white/10 text-white/85"
                    }`}
                  >
                    {control.shortcut}
                  </span>
                  <span className="text-[10px] leading-none text-white/40">
                    {t("companionIntro.call.shortcut")}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 pt-2">
        {/* Where the run is, as dots rather than "4 of 7". The count is not
            information anyone acts on; that it is nearly over is.

            One dot per subject, not per card (see `COMPANION_INTRO_GROUPS`).
            The three cards about a running call are one idea from three angles,
            and a dot crawling through them would tell the user this is long
            while telling them nothing about where they are. */}
        <div className="flex items-center gap-1" aria-hidden>
          {COMPANION_INTRO_GROUPS.map((each) => (
            <span
              key={each}
              className="size-1.5 rounded-full transition-colors"
              style={{
                backgroundColor:
                  each === group
                    ? (accentHex ?? "#5eead4")
                    : "rgba(255,255,255,.2)",
              }}
            />
          ))}
        </div>
        <div className="flex items-center gap-1">
          {/* **The way back, because prose gets reread.** Quieter than the way
              on and to its left, so the pair reads as one direction with a
              correction beside it rather than as two choices. Held out of the
              first beat, where there is nothing behind it: a control that could
              only be pressed to do nothing is worse than no control. The row
              keeps its height either way, since the card's box does. */}
          {isFirst ? null : (
            <button
              type="button"
              className="h-8 whitespace-nowrap rounded-full px-3 text-[14px] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              onClick={() => onAdvance?.("back")}
            >
              {t("companionIntro.back")}
            </button>
          )}
          <button
            type="button"
            className="h-8 whitespace-nowrap rounded-full bg-white/15 px-3 text-[14px] text-white transition-colors hover:bg-white/25"
            onClick={() => onAdvance?.("next")}
          >
            {isLast
              ? t("companionIntro.done")
              : needsPermission && !checkingPermission
                ? t("companionIntro.permission.skip")
                : t("companionIntro.next")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A key, drawn as the key: a square cap with the glyph the user will actually
 * find on the keyboard, which is also the control that takes the gesture.
 *
 * **Square, and the size of a key.** A pill-shaped chip beside a sentence reads
 * as a badge about a key; a square cap with a glyph in the middle and a small
 * mark in the corner reads as the key, because that is the shape of the thing
 * the hand is about to go and find. The corner mark and the centred glyph are
 * the real key's own arrangement.
 *
 * **The globe, not the word.** On every Mac keyboard shipped since 2021 this
 * key carries a globe, and the ones before it carry `fn`; the key is the same
 * key and the app arms it as Fn. So the cap carries both marks, which is what
 * the keyboard itself does, and a user with either keyboard is looking at their
 * own key rather than at a word for it.
 *
 * Drawn rather than described because the alternative is prose about a key
 * ("double tap the Fn key, bottom left") that the reader has to hold in their
 * head while they go and look. The glyph is hidden from a reader and the cap
 * carries a name instead: a screen reader saying "globe f n" names nothing.
 *
 * **It answers the real key, and lights for nothing else.** `taps` is how many
 * times the key on the keyboard has been pressed since this beat came up, and
 * it is the whole of what colours the cap: dark until the user presses, lit on
 * the first press, filled on the second, which is the gesture the card is
 * asking for. Green here means "that landed", and it means nothing else: a cap
 * lit by a permission the user granted at some other time would be green from
 * the moment the beat paints, on every install where the microphone has ever
 * been allowed, which reads as an answer to a press nobody has made.
 *
 * Two steps rather than one, because the gesture is two presses and a cap that
 * looked the same after both would leave the user guessing whether the second
 * arrived. Two is as far as it goes: past the pair there is nothing left to
 * count towards.
 */
function Keycap({
  label,
  taps = 0,
  scolded = false,
  take,
}: {
  label: string;
  /**
   * How many presses of the real key this cap is answering, capped by the
   * caller at the two it draws.
   */
  taps?: number;
  /**
   * Whether this cap has just been clicked by the pointer, which the card has
   * answered in words. The cap leans away from the press rather than lighting
   * up: it is the one press here that is not what was asked for.
   */
  scolded?: boolean;
  /** Take the press. Absent draws the cap as a picture and nothing more. */
  take?: () => void;
}) {
  const look =
    taps >= 2
      ? "border-emerald-300/90 bg-emerald-400/55 text-emerald-50"
      : taps === 1
        ? "border-emerald-400/70 bg-emerald-400/20 text-emerald-100"
        : "border-white/20 bg-white/10 text-white/85";
  const body = (
    <>
      <Globe className="size-4" aria-hidden />
      {/* Bottom left, small, the way the key itself prints it under the
          globe rather than beside it. */}
      <span
        className="absolute bottom-1 left-1.5 text-[9px] leading-none opacity-70"
        aria-hidden
      >
        {label}
      </span>
    </>
  );
  // A key's proportions: square, softly rounded, with the pressed edge drawn as
  // an inner shadow along the bottom so it reads as a cap standing off the card
  // rather than as a swatch printed on it.
  const shape = `relative inline-flex size-11 items-center justify-center rounded-lg border font-medium shadow-[inset_0_-2px_0_rgba(0,0,0,.4)] transition-[color,background-color,border-color,transform] ${look} ${
    // Shrunk back under the pointer that just pressed it, which is a cap
    // declining rather than a cap that did nothing. The card says the words.
    scolded ? "scale-90 opacity-70" : ""
  }`;
  // The pointer's own wash, held back once the key has answered: hover styles
  // are written later in the sheet than the cap's own, so a hand resting over a
  // lit cap would wipe the one piece of feedback the user just earned. A cap
  // that has been pressed properly is also no longer inviting the click.
  const hover = taps === 0 ? "hover:border-white/40 hover:bg-white/20" : "";
  return take === undefined ? (
    <span className={shape} aria-label={label}>
      {body}
    </span>
  ) : (
    <button
      type="button"
      className={`${shape}${hover}`}
      aria-label={label}
      onClick={take}
    >
      {body}
    </button>
  );
}
