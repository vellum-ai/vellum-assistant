import { useEffect, useRef, useState, type MouseEvent } from "react";

import { CompanionCapturePicker } from "@/components/companion-capture-picker";
import { CompanionDictationOffer } from "@/components/companion-dictation-offer";
import {
  CompanionIntro,
  introPhase,
  introSpotlight,
} from "@/components/companion-intro";
import {
  containsPoint,
  onCompanionSurface,
} from "@/components/companion-layout";
import {
  CompanionSurface,
  type CompanionSurfacePhase,
} from "@/components/companion-surface";
import { companionAccentHexFor } from "@/components/companion-accent";
import {
  activateCompanionApp,
  answerCompanionDictationOffer,
  answerCompanionWatchRetro,
  advanceCompanionIntro,
  getCompanionState,
  listCompanionCaptureSources,
  moveCompanionBy,
  setCompanionInteractive,
  setCompanionScreenShare,
  showCompanionContextMenu,
  startCompanionVoice,
  subscribeCompanionState,
  toggleCompanionWatch,
} from "@/runtime/companion-surface";
import { sendVoiceActivityControl } from "@/runtime/desktop-voice-activity";
import { useTranslation } from "@/i18n";
import { COMPANION_BASE_AVATAR_BOX } from "@vellumai/ipc-contract";
import type {
  CompanionCapturePick,
  CompanionCaptureSources,
  CompanionCardGrowth,
  CompanionCharacter,
  CompanionGrowth,
  CompanionIntroBeat,
  CompanionSurfaceState,
  CompanionWatchRetro,
  CompanionDictating,
  VoiceActivityState,
  CompanionDictationOffer as CompanionDictationOfferWords,
  WatchCaptureTarget,
} from "@vellumai/ipc-contract";

/**
 * How far a press may travel and still count as a click.
 *
 * The surface is its own drag handle, so every press is a potential grab. A few
 * pixels of hand tremor between pressing the avatar and letting go must not
 * turn "take me back to Vellum" into a one-pixel nudge that does nothing.
 */
const DRAG_SLOP = 3;

/**
 * The companion surface inside its Electron canvas
 * (`clients/macos/src/main/companion-window.ts`).
 *
 * Standalone (no auth, no RootLayout) like the dictation overlay and Quick
 * Input, so it paints as soon as the window opens. The canvas is transparent
 * and much larger than the pill: the page paints only the pill and leaves the
 * rest of the window empty, which is what lets the expansion be CSS in a window
 * that never resizes.
 *
 * **The page owns interactivity.** The window is click-through so its mostly
 * empty canvas does not swallow presses meant for the desktop behind it, and
 * only the page knows where the pill is actually drawn, so it tells main when
 * the pointer is over the surface and main makes the window clickable for
 * exactly that long.
 *
 * **It draws the running call, and holds none of it.** The session lives in the
 * window with the chat layout in it; main holds the snapshot and pushes it here
 * with the rest of the surface's state, and presses go back out the same way.
 * That is what lets this window reload mid-call without the call noticing.
 */
export function CompanionSurfacePage() {
  const { t } = useTranslation();
  const [growth, setGrowth] = useState<CompanionGrowth>("right");
  // Which side of the avatar the canvas reserves the card's height on, and so
  // which canvas edge the avatar is anchored to. Main's call: it owns the
  // window position and is the only side that knows how much room the display
  // has above the surface.
  const [cardGrowth, setCardGrowth] = useState<CompanionCardGrowth>("up");
  // The creature's box in points and the pill's, which are the surface's whole
  // scale between them. Main sizes the window from both, so they arrive with
  // the state rather than being settings this window reads for itself.
  const [avatarBox, setAvatarBox] = useState(COMPANION_BASE_AVATAR_BOX);
  const [optionsBox, setOptionsBox] = useState(COMPANION_BASE_AVATAR_BOX);
  const [avatarSrc, setAvatarSrc] = useState<string | undefined>();
  const [character, setCharacter] = useState<CompanionCharacter | undefined>();
  const [publishedAccentHex, setPublishedAccentHex] = useState<
    string | undefined
  >();
  const [call, setCall] = useState<VoiceActivityState | null>(null);
  // Whether Talk has been pressed and nothing has answered it yet. Main's, like
  // the call it waits for: the press left this window the moment it was made.
  const [dialing, setDialing] = useState(false);
  const [dictating, setDictating] = useState<CompanionDictating | undefined>(
    undefined,
  );
  const [dictationText, setDictationText] = useState("");
  // The assistant's name, for the introduction's first beat. Empty until the
  // app's window has published one.
  const [assistantName, setAssistantName] = useState("");
  // Whether a turn is in flight, from the window that owns the conversation.
  const [working, setWorking] = useState(false);
  // Whether a session is reading the screen. Its own flag rather than a phase,
  // because the phase is outranked by a call and the capture indicator must
  // not be: the screen is being read whatever the pill is drawing.
  const [watching, setWatching] = useState(false);
  // Where the last finished session's summary has got to, or undefined when
  // there is nothing to say. Its own state for the reason `watching` is.
  const [watchRetro, setWatchRetro] = useState<CompanionWatchRetro | undefined>(
    undefined,
  );
  // Vellum's version of a dictation another app pasted, while the offer to
  // use it stands. Its own state for the reason `watchRetro` is.
  const [dictationOffer, setDictationOffer] = useState<
    CompanionDictationOfferWords | undefined
  >(undefined);
  // Whether Watch is offered at all, which is the flag as main last read it.
  const [watchEnabled, setWatchEnabled] = useState(false);
  // Whether a session started from the app's window can be told what to
  // read, which is that window's answer about its assistant's version. It
  // decides whether Teach asks first or starts at once.
  const [watchTargets, setWatchTargets] = useState(false);
  // What the call is being shown, or undefined when nothing is. Main's, like
  // the call: the press left this window as a pick, and this is what the
  // window holding the session did with it.
  const [screenShare, setScreenShare] = useState<
    WatchCaptureTarget | undefined
  >(undefined);
  // Whether the call can be shown the screen at all, which is that window's
  // answer about its session and its assistant's version.
  const [shareEnabled, setShareEnabled] = useState(false);
  // The picker Teach opened, or null while none is open. This window's own,
  // unlike everything above it: the choice is made here and leaves here as a
  // pick, so a reload mid-choice costs only the card.
  const [picking, setPicking] = useState(false);
  // Which control the open picker answers: Teach starts a session on the
  // pick, Share shows the call it. Meaningless while `picking` is false.
  const [pickingFor, setPickingFor] = useState<"teach" | "share">("teach");
  // What the host listed for it, or null while the host is still being asked.
  const [captureSources, setCaptureSources] =
    useState<CompanionCaptureSources | null>(null);
  // Which ask for the list is the current one. The answer arrives after a
  // round trip, and a picker closed or reopened in the meantime must not be
  // answered by it: a stale "nothing to list" would start a whole-screen
  // session the user has just declined to choose.
  const sourcesRequestRef = useRef(0);
  const [hovered, setHovered] = useState(false);
  // Which beat of the one-time introduction is on screen, or null when none is.
  // Main's, like the session: this window can reload mid-run, and a beat held
  // here would reset to the first one when it did.
  const [intro, setIntro] = useState<CompanionIntroBeat | null>(null);
  // Mirrors what main was last told, so a pointer crossing the pill does not
  // send the same instruction on every mouse-move.
  const interactiveRef = useRef(false);
  const pillRef = useRef<HTMLDivElement | null>(null);
  // The creature's own box, hit-tested beside the pill rather than inside it:
  // the two are siblings with a gap between them, and at rest the avatar is the
  // only part of the surface drawn at all.
  const avatarRef = useRef<HTMLDivElement | null>(null);
  // The introduction's card, hit-tested alongside the pill: it carries the only
  // two controls in the run, and a click-through window would drop presses on
  // them onto whatever is behind it.
  const introRef = useRef<HTMLDivElement | null>(null);
  // The picker's card, hit-tested for the reason the introduction's is: every
  // row on it is a press.
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // The offer's card, for the reason the picker's is.
  const offerRef = useRef<HTMLDivElement | null>(null);
  // Screen coordinates of the last drag frame, or null when not dragging.
  // Screen rather than client: the window moves under the cursor, so client
  // coordinates barely change while screen ones track the hand exactly.
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  // Where the current press started, and whether it has travelled far enough to
  // be a drag rather than a click. Every press starts as both: the surface is
  // its own drag handle, so a press on the avatar is a grab until the hand
  // moves, and a click once it lifts without having moved.
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  useEffect(() => {
    const apply = (state: CompanionSurfaceState) => {
      setGrowth(state.growth);
      setCardGrowth(state.cardGrowth);
      setAvatarBox(state.avatarBox);
      // The creature's box unless the pill has one of its own, which covers a
      // shell that predates the second axis: one box for both is the surface
      // that side is drawing.
      setOptionsBox(state.optionsBox ?? state.avatarBox);
      setAvatarSrc(
        state.avatarBase64 === undefined
          ? undefined
          : `data:image/png;base64,${state.avatarBase64}`,
      );
      setCharacter(state.character);
      setPublishedAccentHex(state.accentHex);
      setCall(state.call);
      // Off unless positively on, the way `watching` is read: a shell that
      // predates the field is not dialing.
      setDialing(state.dialing === true);
      setAssistantName(state.assistantName);
      setWorking(state.working);
      // Absence is not a session: every state that is not a positive answer
      // reads as nothing running, because the alternative is a capture
      // indicator over a machine nobody is reading.
      setWatching(state.watching === true);
      setDictating(state.dictating);
      setDictationText(state.dictationText ?? "");
      setWatchRetro(state.watchRetro);
      setDictationOffer(state.dictationOffer);
      // Off unless the answer is positively yes, which covers a shell that
      // predates the field and a window whose flags have not synced yet. The
      // control this decides starts reading the user's screen, so a state of
      // not knowing has to read as not offering it.
      setWatchEnabled(state.watchEnabled === true);
      // Off unless positively on, for the reason the flag is: a pick taken
      // from the user is a promise about what will be read, and a window that
      // has not said its assistant can keep it is one that cannot.
      setWatchTargets(state.watchTargets === true);
      setScreenShare(state.screenShare);
      // Off unless positively on, for the reason `watchTargets` is.
      setShareEnabled(state.screenShareEnabled === true);
      setIntro(state.intro);
    };
    const unsubscribe = subscribeCompanionState(apply);
    // The route chunk loads lazily after the window is created, so a state
    // pushed before this subscription registered was dropped. Catch up.
    void getCompanionState().then((initial) => {
      if (initial) {
        apply(initial);
      }
    });
    return unsubscribe;
  }, []);

  // Never leave the window clickable behind us. An unmount mid-hover would
  // otherwise strand a transparent canvas that eats every click on that corner
  // of the screen.
  useEffect(() => {
    return () => {
      setCompanionInteractive(false);
    };
  }, []);

  /**
   * The picker closes on its own when the choice stops being askable.
   *
   * A session starting is the pick answered, whichever window answered it. A
   * call ending takes the row Teach sits on with it, and a card left over a
   * bar that is gone would be asking a question nobody can act on.
   */
  const inCall = call !== null || dialing;
  const sharing = screenShare !== undefined;
  useEffect(() => {
    if (!inCall) {
      sourcesRequestRef.current += 1;
      setPicking(false);
    }
  }, [inCall]);
  // Each control's picker closes on its own answer: Teach's on a session
  // starting, Share's on a share starting. Not the other's, since a share
  // beginning while the user is choosing what to teach from is not an answer
  // to that question.
  useEffect(() => {
    if (watching && pickingFor === "teach") {
      sourcesRequestRef.current += 1;
      setPicking(false);
    }
  }, [watching, pickingFor]);
  useEffect(() => {
    if (sharing && pickingFor === "share") {
      sourcesRequestRef.current += 1;
      setPicking(false);
    }
  }, [sharing, pickingFor]);

  /**
   * Teach, with no session running.
   *
   * Where the app's window can aim a session, the press opens the picker and
   * the pick starts the session; a second press closes it unanswered. Where it
   * cannot, or where the shell has no list to offer, the press starts the
   * whole-screen session it always started, so Teach never does nothing.
   */
  /**
   * Open the picker for `control`, asking the host what there is to pick,
   * or hand the control its no-picker answer when the host has no list.
   */
  const openPicker = (
    control: "teach" | "share",
    withoutPicker: () => void,
  ) => {
    setCaptureSources(null);
    setPickingFor(control);
    setPicking(true);
    const request = ++sourcesRequestRef.current;
    void listCompanionCaptureSources().then((listed) => {
      // The picker this answers is gone: closed by a press, by a session
      // starting, by the call ending, or replaced by a newer ask.
      if (request !== sourcesRequestRef.current) {
        return;
      }
      if (listed !== null) {
        setCaptureSources(listed);
        return;
      }
      // A shell that predates the picker. The question cannot be asked, so
      // it is not left on screen.
      setPicking(false);
      withoutPicker();
    });
  };

  const onTeach = () => {
    if (!watchTargets) {
      toggleCompanionWatch();
      return;
    }
    // A second press closes it unanswered. A press while Share's picker is
    // open replaces its question with this one.
    if (picking && pickingFor === "teach") {
      sourcesRequestRef.current += 1;
      setPicking(false);
      return;
    }
    // The session starts the old way instead, reading the whole screen.
    openPicker("teach", toggleCompanionWatch);
  };

  /**
   * Share, with nothing being shared: open the picker. A second press closes
   * it unanswered. Unlike Teach there is no whole-screen fallback, since a
   * share is of something in particular; a shell with no list has nothing to
   * offer and the press does nothing.
   */
  const onShare = () => {
    if (picking && pickingFor === "share") {
      sourcesRequestRef.current += 1;
      setPicking(false);
      return;
    }
    openPicker("share", () => undefined);
  };

  // A row pressed under a still pointer removes the card and nothing moves,
  // so no mouse-move arrives to hand the desktop back. Give it back here,
  // the way the introduction's card does; the next move re-arms the window
  // if the pointer is still on the surface.
  useEffect(() => {
    if (!picking && interactiveRef.current) {
      interactiveRef.current = false;
      setCompanionInteractive(false);
    }
  }, [picking]);

  // An answer or the offer's own expiry removes the card, and if the pointer
  // is resting on it nothing moves, so no mouse-move arrives to hand the
  // desktop back. Give it back here, the way the picker does.
  useEffect(() => {
    if (dictationOffer === undefined && interactiveRef.current) {
      interactiveRef.current = false;
      setCompanionInteractive(false);
    }
  }, [dictationOffer]);

  const onPick = (pick: CompanionCapturePick) => {
    sourcesRequestRef.current += 1;
    setPicking(false);
    if (pickingFor === "share") {
      setCompanionScreenShare(pick);
      return;
    }
    toggleCompanionWatch(pick);
  };

  const setInteractive = (next: boolean) => {
    if (interactiveRef.current === next) {
      return;
    }
    interactiveRef.current = next;
    setCompanionInteractive(next);
  };

  // Whether the introduction's card is actually on screen. The beat alone does
  // not settle it: a call withdraws the card while main is still holding the
  // run.
  const introShown = intro !== null && call === null && !dialing;

  /**
   * Give the desktop back when the introduction's card goes away.
   *
   * The card is hit-tested as part of the surface, so a pointer resting on it
   * has left the window clickable. Skip and "Got it" both remove the card from
   * under that pointer, and a call arriving does the same, and none of them are
   * a mouse-move: the hand is holding still on a card that is gone.
   * Left alone the window stays clickable across a canvas many times the size
   * of the pill, swallowing presses meant for whatever the user was working in.
   *
   * Collapsing to rest is self-correcting instead: a click-through window still
   * receives forwarded mouse-move, so a pointer genuinely left on the pill
   * re-arms on the next pixel of movement.
   */
  const introWasShown = useRef(introShown);
  useEffect(() => {
    if (introWasShown.current && !introShown) {
      setHovered(false);
      setInteractive(false);
    }
    introWasShown.current = introShown;
  }, [introShown]);

  // **A running call outranks the pointer.** The surface is otherwise a circle
  // that only becomes a pill while it is being pointed at, and a live
  // microphone that hides itself the moment the pointer leaves is a live
  // microphone the user cannot see. So the call holds the pill open, and
  // hovering it changes nothing: the controls it wants are already there.
  //
  // A dial is the call's own first beat and ranks with it. The press that
  // made it leaves this window at once, and a pill that closed behind the
  // hand while the session it asked for was still on its way would read as
  // a press that did nothing.
  //
  // A watch session holds the pill open for the same reason the call does, and
  // ranks below it: the call is something the user is in the middle of, where
  // this one runs beside whatever they are doing. Being outranked costs the
  // session nothing, since the phase is only what the pill is drawing and the
  // indicator reads `watching` instead.
  //
  // The summary of a finished session sits between the two: it outranks hover
  // because it is a wait the user is owed an answer to and then a question
  // waiting on one, and it is outranked by a session still recording, which is
  // the one thing on this surface a user must always be able to see and stop.
  // The introduction sits above the pointer and below everything the user is in
  // the middle of. A beat that names a control has to have that control on
  // screen to name, so it holds the pill open the way a call does; but a run
  // still going when a call starts must give way, because the call is the
  // user's own business and this is a caption.
  const introHeld = introPhase(intro);
  const phase: CompanionSurfacePhase =
    call !== null || dialing
      ? "call"
      : dictating !== undefined
        ? "dictating"
        : dictationOffer !== undefined
          ? "offer"
          : watching
            ? "watching"
            : watchRetro !== undefined
              ? "summary"
              : (introHeld ?? (hovered ? "hover" : "resting"));

  /**
   * Hit-test the pointer against the surface on every move.
   *
   * Not `mouseenter`: a click-through window delivers forwarded mouse-move and
   * little else, so entering and leaving have to be derived from coordinates.
   * `dictation-overlay-page.tsx` measures its stop button the same way for the
   * same reason. The rects are read live rather than cached because the pill
   * changes width as it expands, and a stale rect would collapse the surface
   * the moment it finished growing.
   *
   * **The surface is several rects, and the answer is their union.** The
   * creature, the pill beside it, the strip of gap between them, and the
   * introduction's card while it is drawn; see {@link onCompanionSurface} for
   * why the box around them all is the wrong shape.
   */
  const onMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    // **A drag whose release this window never saw ends here.**
    //
    // The drag is ended by `mouseup`, which the capture the press takes
    // delivers wherever the button comes up. The host can still break that
    // capture, and the release then lands somewhere this page is not.
    //
    // Left alone that press never ends. Every later move is read as a drag
    // frame, so the surface follows a pointer with no button held and the first
    // move after the pointer returns carries the whole distance travelled in
    // between, flinging it across the desktop. Hit-testing never resumes
    // either, so the window stays clickable across a canvas many times the size
    // of the pill, swallowing presses meant for whatever is behind it. That is
    // the state that reads as the surface being dead until the app is
    // relaunched.
    //
    // No button held means the press is over, whatever this window saw of it,
    // so the drag is dropped and this move goes on to hit-test normally.
    if (dragRef.current !== null && event.buttons === 0) {
      dragRef.current = null;
    }
    // A drag owns the pointer until it is released. Hit-testing through it
    // would collapse the surface the moment the cursor left the pill, which is
    // most of any drag worth making.
    if (dragRef.current !== null) {
      const { x, y } = dragRef.current;
      moveCompanionBy(event.screenX - x, event.screenY - y);
      dragRef.current = { x: event.screenX, y: event.screenY };
      const origin = pressOriginRef.current;
      if (
        origin !== null &&
        Math.abs(event.screenX - origin.x) +
          Math.abs(event.screenY - origin.y) >
          DRAG_SLOP
      ) {
        draggedRef.current = true;
      }
      return;
    }
    const avatar = avatarRef.current;
    if (!avatar) {
      return;
    }
    // **The pill is part of the surface for as long as it is drawn**, and that
    // outlasts the expanded phase by the width transition: the moment the
    // pointer leaves, the phase is resting while the pill is still on screen
    // collapsing through 300ms of width. So the measured width decides, not the
    // phase, and a pointer coming back over what is still drawn arms the window
    // and re-opens the pill rather than clicking into the application behind
    // it. At rest the width is zero, and a rect of nothing beside the creature
    // is not somewhere a pointer can be.
    //
    // Reading a box forces layout, and this runs on every pixel of every
    // mouse-move the host forwards, so each is read exactly once.
    const pillRect = pillRef.current?.getBoundingClientRect() ?? null;
    const onSurface = onCompanionSurface(
      { x: event.clientX, y: event.clientY },
      {
        avatar: avatar.getBoundingClientRect(),
        pill: pillRect !== null && pillRect.width > 0 ? pillRect : null,
      },
    );
    // The introduction's card is part of the surface for as long as it is
    // drawn. Testing only the surface would leave the window click-through over
    // Next and Skip, so the presses meant to end the run would land on whatever
    // application is behind it instead.
    const introCard = introRef.current;
    const onIntro =
      introCard !== null &&
      containsPoint(
        introCard.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
    // The offer's card, for the same reason and for as long as it is drawn.
    const offerCard = offerRef.current;
    const onOffer =
      offerCard !== null &&
      containsPoint(
        offerCard.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
    // The picker's card, for the same reason and for as long as it is drawn.
    const pickerCard = pickerRef.current;
    const onPicker =
      pickerCard !== null &&
      containsPoint(
        pickerCard.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
    // Hover is the creature noticing a hand on *it*, so the card does not feed
    // it: a pointer resting on a paragraph is not a pointer on the avatar, and
    // widening the eyes for it would be the surface reacting to the wrong
    // thing.
    setHovered(onSurface);
    setInteractive(onSurface || onIntro || onPicker || onOffer);
  };

  // The avatar's own colour, shared with the display's edge glow so the two
  // lights cannot come apart. See `companionAccentHexFor`.
  const accentHex = companionAccentHexFor(call, publishedAccentHex, character);

  return (
    <div
      className="relative h-screen w-screen bg-transparent"
      onMouseMove={onMouseMove}
      onMouseUp={() => {
        dragRef.current = null;
      }}
      onPointerCancel={() => {
        // The capture goes with the pointer when the host takes it, so nothing
        // more reports this press, and a leave that deferred to the drag may
        // never arrive. Give the desktop back the way a leave does; a pointer
        // still on the pill re-arms it on its next move.
        dragRef.current = null;
        setHovered(false);
        setInteractive(false);
      }}
      onMouseLeave={() => {
        // A leave is not a release. A drag can carry the pointer off the canvas
        // and back, and handing the desktop back mid-press would put the window
        // click-through under a button that is still down. Only a release ends
        // the drag, seen as `mouseup` or as a move with no button held.
        if (dragRef.current !== null) {
          return;
        }
        // The pointer left the canvas entirely, which mouse-move cannot report.
        setHovered(false);
        setInteractive(false);
      }}
    >
      {/* The surface at whatever size the user picked, which it draws itself:
          it takes the two boxes and scales its own outermost element by the
          options one, so this page holds no dimensions of its own.

          Nothing here has to know. Hit-testing reads `getBoundingClientRect`,
          which is post-transform, and the drag is in screen deltas. */}
      <CompanionSurface
        phase={phase}
        growth={growth}
        cardGrowth={cardGrowth}
        // The two boxes main sized the window for. The surface spends the
        // options one on its own outermost box and uses both to place the pill
        // against a creature that may be a different size from it.
        avatarBox={avatarBox}
        optionsBox={optionsBox}
        avatarSrc={avatarSrc}
        character={character}
        // The creature notices the hand, in every state including mid-call.
        hovered={hovered}
        accentHex={accentHex}
        call={call ?? undefined}
        // For the dial, which names who is being called. The call itself
        // carries its own name once it arrives.
        assistantName={assistantName}
        dictating={dictating}
        dictationText={dictationText}
        // Whether the assistant is busy, on whatever conversation the app has
        // open: the surface is its presence on the desktop rather than a view
        // of one thread.
        working={working}
        // Its own prop rather than something the surface derives from the
        // phase. The phase above is outranked by `call`, and the indicator and
        // the control that ends the session are not: they belong to the
        // session, not to whatever the pill is drawing over it.
        watching={watching}
        // Its own prop rather than something derived from the phase, for the
        // reason `watching` is: a call outranks the phase, and a question the
        // user has been asked must not lose its answer because they picked up
        // the phone.
        watchRetro={watchRetro}
        // Out through main and into the window that ran the retrospective. A
        // yes raises the app on the report; a no leaves the window where it
        // is. Neither is handled here: this page has no conversation and no
        // router, and the answer has to reach the side holding the question
        // or the prompt comes back on the next push.
        onWatchRetro={answerCompanionWatchRetro}
        // Out through main to the window that made the offer, for the reason
        // the retro's answer goes: this page holds neither the words nor the
        // application they went into. The answer names the offer it was drawn
        // against, since this page can be a frame behind the window holding
        // it.
        dictationOffer={dictationOffer}
        offer={
          dictationOffer !== undefined ? (
            <CompanionDictationOffer
              offer={dictationOffer}
              growth={growth}
              cardGrowth={cardGrowth}
              avatarBox={avatarBox}
              optionsBox={optionsBox}
              cardRef={offerRef}
              onAnswer={(answer) => {
                answerCompanionDictationOffer(answer, dictationOffer.id);
              }}
            />
          ) : null
        }
        // The reads that session has taken, which is what turns a running
        // session into something the user can see happening rather than
        // something they are told is on.
        // The flag, from main. It hides the way into a session and leaves
        // everything a running one draws alone, so a session already going
        // when the flag turns off can still be seen and still be stopped.
        watchEnabled={watchEnabled}
        // Draws the control the beat is about as though the pointer were on
        // it. The pill is open on those beats but the pointer is wherever the
        // user's hand happens to be, so without this the beat names a control
        // the user then has to hunt for among the others.
        spotlight={introSpotlight(intro)}
        // Beside the pill rather than inside it, on the canvas main reserves
        // for a card. Null between runs, which is every launch after the
        // first.
        //
        // **Withdrawn, not ended, by a call.** That state rebuilds the pill out
        // of different controls, so a beat captioning Talk would be labelling
        // a control that is not on screen. Main still holds the beat, so the
        // run resumes where it was once the call is over.
        intro={
          !introShown || intro === null ? null : (
            <CompanionIntro
              beat={intro}
              growth={growth}
              cardGrowth={cardGrowth}
              // The card clears whatever the pill draws beside the creature,
              // so it is given the same two boxes.
              avatarBox={avatarBox}
              optionsBox={optionsBox}
              accentHex={accentHex}
              // Undefined rather than empty: the first beat introduces the
              // creature by name, and before the app's window has published
              // one there is no name to introduce it by.
              assistantName={assistantName === "" ? undefined : assistantName}
              cardRef={introRef}
              onAdvance={advanceCompanionIntro}
            />
          )
        }
        rootRef={pillRef}
        avatarRef={avatarRef}
        onSurfacePointerDown={(event) => {
          // A right-click is a menu, not a grab. Left alone it would arm the
          // drag and then never be released by a `mouseup` this window sees,
          // because the menu takes the pointer for as long as it is open. It
          // must not take the capture below either, for the same reason.
          if (event.button !== 0) {
            return;
          }
          // A press on a control is not a grab, and here it must not even arm
          // one: capture retargets the click to whatever holds it, so a press
          // that took capture from a control is a click that control never
          // sees. The surface's own controls stop the press themselves; this
          // is the guard for anything drawn on it that cannot.
          if ((event.target as Element).closest("button, a") !== null) {
            return;
          }
          // The window is moved a message at a time, so it trails the hand and
          // a quick drag carries the pointer off the canvas. Capture keeps the
          // moves and the release coming here regardless of what the pointer is
          // over, and holds the canvas's `mouseleave` back until the button is
          // up.
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.screenX, y: event.screenY };
          pressOriginRef.current = { x: event.screenX, y: event.screenY };
          draggedRef.current = false;
        }}
        onSurfaceContextMenu={(event) => {
          // **Selected text keeps its own menu.** A right-click on text the
          // user has selected wants Copy, which the host already provides.
          // Swallowing that to offer "Small / Medium / Large" would take away
          // the only way to copy something off the surface.
          const onSelection =
            (window.getSelection()?.toString().trim().length ?? 0) > 0;
          if (onSelection) {
            return;
          }
          event.preventDefault();
          // Main pops the menu at the pointer, so the window has to still be
          // clickable when it does. It is: the pointer is on the pill, which
          // is the only thing that makes this window interactive at all.
          showCompanionContextMenu();
        }}
        // A press that never became a drag. **The creature is the call
        // button.** Idle, the press asks for a session: it leaves this window
        // immediately, since the session lives in the renderer holding the
        // chat layout, and what comes back is `call` once that renderer has
        // one to report. On a call, or dialing one, the press brings Vellum
        // forward on the conversation the call is in, which is where the room
        // and the transcript are; main decides what that means.
        onAvatarClick={() => {
          if (draggedRef.current) {
            return;
          }
          if (call !== null || dialing) {
            activateCompanionApp();
            return;
          }
          startCompanionVoice();
        }}
        // One press for both edges, and it leaves this window the way Talk
        // does: the session lives in the renderer holding the chat layout,
        // and this page only asks for it. What comes back is `watching`.
        // Wrapped so the click's event never rides along as a pick.
        onWatch={() => {
          toggleCompanionWatch();
        }}
        // The way in, when there is a choice to make first. The stop stays on
        // `onWatch`; this is only ever the press with no session running.
        onTeach={onTeach}
        picking={picking && pickingFor === "teach"}
        // The share, from main, and the two presses that move it. The stop
        // leaves this window the way a pick does, carrying nothing.
        sharing={sharing}
        shareEnabled={shareEnabled}
        sharePicking={picking && pickingFor === "share"}
        onShare={onShare}
        onStopShare={() => {
          setCompanionScreenShare();
        }}
        // Beside the bar while the choice is open, on the canvas main
        // reserves for a card. The pick leaves this window the way every
        // press does; the frame that answers it is main's.
        picker={
          picking ? (
            <CompanionCapturePicker
              sources={captureSources}
              cardGrowth={cardGrowth}
              avatarBox={avatarBox}
              optionsBox={optionsBox}
              cardRef={pickerRef}
              label={
                pickingFor === "share"
                  ? t("companionSurface.sharePicker")
                  : undefined
              }
              onPick={onPick}
            />
          ) : null
        }
        // Out through main and back down into whichever renderer holds the
        // session. This page has no session to act on: it draws one.
        onControl={(action, requestId) => {
          sendVoiceActivityControl(
            requestId === undefined ? { action } : { action, requestId },
          );
        }}
      />
    </div>
  );
}
