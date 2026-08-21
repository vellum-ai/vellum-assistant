import { useEffect, useRef, useState, type MouseEvent } from "react";

import {
  CompanionIntro,
  introPhase,
  introSpotlight,
} from "@/components/companion-intro";
import {
  CompanionSurface,
  type CompanionSurfacePhase,
} from "@/components/companion-surface";
import {
  activateCompanionApp,
  answerCompanionWatchRetro,
  advanceCompanionIntro,
  getCompanionState,
  moveCompanionBy,
  setCompanionComposing,
  setCompanionInteractive,
  showCompanionContextMenu,
  startCompanionVoice,
  submitCompanionMessage,
  subscribeCompanionState,
  toggleCompanionWatch,
} from "@/runtime/companion-surface";
import { sendVoiceActivityControl } from "@/runtime/desktop-voice-activity";
import type {
  CompanionCardGrowth,
  CompanionCharacter,
  CompanionGrowth,
  CompanionIntroBeat,
  CompanionSurfaceState,
  CompanionTurn,
  CompanionWatchRetro,
  VoiceActivityState,
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
 * The avatar's box the surface's layout is authored at.
 *
 * Matches `BASE_AVATAR_BOX` in `companion-window.ts`. Main publishes the box it
 * actually sized the window for, and the ratio between the two is the scale:
 * one number, and the surface below is the same layout multiplied.
 */
const BASE_AVATAR_BOX = 44;

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
  const [growth, setGrowth] = useState<CompanionGrowth>("right");
  // Which way the card unfurls, and so which canvas edge the avatar is anchored
  // to. Main's call: it owns the window position and is the only side that
  // knows how much room the display has above the surface.
  const [cardGrowth, setCardGrowth] = useState<CompanionCardGrowth>("up");
  // The avatar's box in points, which is the surface's whole scale. Main sizes
  // the window from it, so it arrives with the state rather than being a
  // setting this window reads for itself.
  const [avatarBox, setAvatarBox] = useState(BASE_AVATAR_BOX);
  const [avatarSrc, setAvatarSrc] = useState<string | undefined>();
  const [character, setCharacter] = useState<CompanionCharacter | undefined>();
  const [call, setCall] = useState<VoiceActivityState | null>(null);
  const [turns, setTurns] = useState<CompanionTurn[]>([]);
  // Empty until the app's window publishes one, which the surface covers with
  // the component's own fallback wording rather than drawing a blank name.
  const [assistantName, setAssistantName] = useState("");
  // Whether a turn is in flight, from the window that owns it. What the surface
  // draws as its working ring, so the assistant being busy is legible without
  // opening the card or reading a word of it.
  const [working, setWorking] = useState(false);
  // Whether a session is reading the screen, from the window that owns it.
  // Held by main and pushed here with everything else, so this window can
  // reload mid-session without the indicator that says so going dark.
  const [watching, setWatching] = useState(false);
  // Where the last session's summary has got to, from the window that ran it.
  // Undefined is the resting answer and the only one that draws nothing: both
  // of the others are claims that something is happening.
  const [watchRetro, setWatchRetro] = useState<CompanionWatchRetro | undefined>(
    undefined,
  );
  // How many times the running session has read the screen. Held with the flag
  // rather than derived from it, because the flag is a state that lasts for
  // minutes and this is the only account of the discrete moments inside it.
  const [captureCount, setCaptureCount] = useState(0);
  // Whether Watch is offered at all, from the only side of this surface that
  // can know. This window never hydrates a flag store: it has no auth and no
  // `RootLayout`, so it would sit on registry defaults forever. Main reads the
  // evaluation the app's window wrote into settings and pushes it here.
  const [watchEnabled, setWatchEnabled] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Which beat of the one-time introduction is on screen, or null when none is.
  // Main's, like the session: this window can reload mid-run, and a beat held
  // here would reset to the first one when it did.
  const [intro, setIntro] = useState<CompanionIntroBeat | null>(null);
  // Whether the composer is open. Local to this page rather than pushed from
  // main, because nothing outside this window opens or closes it: main is told
  // about it only so it can lend the window the keyboard.
  const [typing, setTyping] = useState(false);
  // Whether this composer has sent anything yet, which is both what decides
  // between starting a conversation and continuing one, and what tells the card
  // whether the turns arriving from main are its own. Before the first message
  // they are whatever the app happens to have open, which is precisely the
  // conversation this surface has decided not to join.
  const [started, setStarted] = useState(false);
  // Mirrors what main was last told, so a pointer crossing the pill does not
  // send the same instruction on every mouse-move.
  const interactiveRef = useRef(false);
  const pillRef = useRef<HTMLDivElement | null>(null);
  // The introduction's card, hit-tested alongside the pill: it carries the only
  // two controls in the run, and a click-through window would drop presses on
  // them onto whatever is behind it.
  const introRef = useRef<HTMLDivElement | null>(null);
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
      setAvatarSrc(
        state.avatarBase64 === undefined
          ? undefined
          : `data:image/png;base64,${state.avatarBase64}`,
      );
      setCharacter(state.character);
      setCall(state.call);
      setTurns(state.turns);
      setAssistantName(state.assistantName);
      setWorking(state.working);
      // Absence is not a session: every state that is not a positive answer
      // reads as nothing running, because the alternative is a capture
      // indicator over a machine nobody is reading.
      setWatching(state.watching === true);
      setWatchRetro(state.watchRetro);
      // Absence is no reads, for the same reason absence is no session: a
      // state that cannot say how much of the screen was taken has not
      // established that any of it was.
      setCaptureCount(state.captureCount ?? 0);
      // Off unless the answer is positively yes, which covers a shell that
      // predates the field and a window whose flags have not synced yet. The
      // control this decides starts reading the user's screen, so a state of
      // not knowing has to read as not offering it.
      setWatchEnabled(state.watchEnabled === true);
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

  // Never leave the window clickable or holding the keyboard behind us. An
  // unmount mid-hover would otherwise strand a transparent canvas that eats
  // every click on that corner of the screen, and an unmount mid-composer a
  // panel holding key status with nothing left on it to receive a keystroke:
  // the user's next words would go nowhere.
  useEffect(() => {
    return () => {
      setCompanionInteractive(false);
      setCompanionComposing(false);
    };
  }, []);

  // The window may hold the keyboard for exactly as long as there is a field to
  // type into, which is the keyboard's half of what `setInteractive` does for
  // the pointer.
  useEffect(() => {
    setCompanionComposing(typing);
  }, [typing]);

  const setInteractive = (next: boolean) => {
    if (interactiveRef.current === next) {
      return;
    }
    interactiveRef.current = next;
    setCompanionInteractive(next);
  };

  /**
   * Close the composer and put the surface back to rest.
   *
   * **Hover has to be dropped with it.** Hover is derived from hit-testing the
   * pointer against the surface's own box on every move, and the box the last
   * move tested was the card: a 360pt panel standing well above the pill. The
   * moment the card is gone that answer describes a shape that no longer
   * exists, and nothing corrects it, because the correction is a mouse-move and
   * the hand that just pressed "go back" is holding still. Left alone the
   * surface sits in its expanded hover state with the pointer nowhere near it,
   * and the window stays clickable across a stretch of empty canvas, swallowing
   * presses meant for the desktop behind it.
   *
   * Collapsing to rest is self-correcting instead: the window goes
   * click-through, which still forwards mouse-move, so a pointer genuinely left
   * on the pill re-expands it on the next pixel of movement.
   */
  // Whether the introduction's card is actually on screen. The beat alone does
  // not settle it: a call or the composer withdraws the card while main is
  // still holding the run.
  const introShown = intro !== null && !typing && call === null;

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
   * The same correction `closeComposer` makes, and self-correcting the same
   * way: a click-through window still receives forwarded mouse-move, so a
   * pointer genuinely left on the pill re-arms on the next pixel of movement.
   */
  const introWasShown = useRef(introShown);
  useEffect(() => {
    if (introWasShown.current && !introShown) {
      setHovered(false);
      setInteractive(false);
    }
    introWasShown.current = introShown;
  }, [introShown]);

  const closeComposer = () => {
    setTyping(false);
    setHovered(false);
    setInteractive(false);
    // The thread is done with the card. Opening Type again starts a fresh one,
    // which is what makes the surface's conversation the surface's rather than
    // an ever-growing one the user never chose to be in.
    setStarted(false);
  };

  /**
   * Hit-test the pointer against the pill on every move.
   *
   * Not `mouseenter`: a click-through window delivers forwarded mouse-move and
   * little else, so entering and leaving have to be derived from coordinates.
   * `dictation-overlay-page.tsx` measures its stop button the same way for the
   * same reason. The rect is read live rather than cached because the pill
   * changes width as it expands, and a stale rect would collapse the surface
   * the moment it finished growing.
   */
  const onMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    // **A drag whose release this window never saw ends here.**
    //
    // The drag is ended by `mouseup` or by the pointer leaving the canvas, and
    // both are events this window has to receive. Neither arrives when the
    // button comes up over another app: the canvas is a bounded rectangle, a
    // fast drag outruns a window that is moved a message at a time, and the
    // release then lands somewhere this page is not.
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
    const pill = pillRef.current;
    if (!pill) {
      return;
    }
    const within = (element: HTMLElement | null): boolean => {
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    };
    const onPill = within(pill);
    // The introduction's card is part of the surface for as long as it is
    // drawn. Testing only the pill would leave the window click-through over
    // Next and Skip, so the presses meant to end the run would land on whatever
    // application is behind it instead.
    const onIntro = within(introRef.current);
    // Hover is the creature noticing a hand on *it*, so the card does not feed
    // it: a pointer resting on a paragraph is not a pointer on the avatar, and
    // widening the eyes for it would be the surface reacting to the wrong
    // thing.
    setHovered(onPill);
    setInteractive(onPill || onIntro);
  };

  // **An open composer outranks everything, and a running call outranks the
  // pointer.** The surface is otherwise a circle that only becomes a pill while
  // it is being pointed at, and a live microphone that hides itself the moment
  // the pointer leaves is a live microphone the user cannot see. So the call
  // holds the pill open, and hovering it changes nothing: the controls it wants
  // are already there.
  //
  // The composer sits above even that, because it is the one state holding
  // something of the user's. A call starting from the app while a sentence is
  // half-typed must not collapse the card and take the sentence with it.
  //
  // A watch session holds the pill open for the same reason the call does, and
  // ranks below both: they are things the user is in the middle of, where this
  // one runs beside whatever they are doing. Being outranked costs the session
  // nothing, since the phase is only what the pill is drawing and the indicator
  // reads `watching` instead.
  //
  // The summary of a finished session sits between the two: it outranks hover
  // because it is a wait the user is owed an answer to and then a question
  // waiting on one, and it is outranked by a session still recording, which is
  // the one thing on this surface a user must always be able to see and stop.
  // The introduction sits above the pointer and below everything the user is in
  // the middle of. A beat that names a control has to have that control on
  // screen to name, so it holds the pill open the way a call does; but a run
  // still going when a call starts or the composer opens must give way, because
  // those are the user's own business and this is a caption.
  const introHeld = introPhase(intro);
  const phase: CompanionSurfacePhase = typing
    ? "typing"
    : call !== null
      ? "call"
      : watching
        ? "watching"
        : watchRetro !== undefined
          ? "summary"
          : (introHeld ?? (hovered ? "hover" : "resting"));

  // The avatar's own colour, which arrives with the session. It is `""` until
  // the avatar resolves and the contract makes no promise it parses, so
  // anything that is not an obvious `#RRGGBB` falls back to the component's
  // default rather than being handed to CSS, where an invalid value silently
  // drops the custom property and takes the glyph's colour with it.
  const accentHex =
    call !== null && /^#[0-9a-f]{6}$/i.test(call.accentHex)
      ? call.accentHex
      : undefined;

  return (
    <div
      className="relative h-screen w-screen bg-transparent"
      onMouseMove={onMouseMove}
      onMouseUp={() => {
        dragRef.current = null;
      }}
      onMouseLeave={() => {
        // The pointer left the canvas entirely, which mouse-move cannot report.
        // A drag ends here too: the button came up somewhere we cannot see.
        dragRef.current = null;
        setHovered(false);
        setInteractive(false);
      }}
    >
      {/* The surface at whatever size the user picked, as the one layout
          multiplied rather than a second set of dimensions.

          The box is the base canvas: the window divided by the scale, blown
          back up about its own top-left corner, so it covers the window exactly
          and every length inside (the `100%` the surface anchors to, its
          paddings, its type) resolves in the units the layout was written in.
          The alternative was scaling forty hard-coded dimensions and keeping
          them in step with main's arithmetic, which is the drift this avoids
          rather than manages.

          Nothing else has to know. Hit-testing reads `getBoundingClientRect`,
          which is post-transform, and the drag is in screen deltas. */}
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: `${(100 * BASE_AVATAR_BOX) / avatarBox}%`,
          height: `${(100 * BASE_AVATAR_BOX) / avatarBox}%`,
          transform: `scale(${avatarBox / BASE_AVATAR_BOX})`,
        }}
      >
        <CompanionSurface
          phase={phase}
          growth={growth}
          cardGrowth={cardGrowth}
          avatarSrc={avatarSrc}
          character={character}
          // The creature notices the hand, in every state including mid-call.
          hovered={hovered}
          accentHex={accentHex}
          // The conversation, as far as the card shows it. Held by main and
          // pushed with the rest of the state, so it survives this window
          // reloading mid-exchange.
          //
          // Nothing at all until this composer has sent something: what main is
          // holding until then belongs to whatever conversation the app has open,
          // and showing it would promise that the message about to be typed joins
          // it, which is exactly what pressing Type no longer does.
          turns={started ? turns : []}
          // The assistant's own name in the composer's placeholder. Undefined
          // rather than empty, so the component's fallback is what fills the gap
          // before the app's window has published one.
          assistantName={assistantName === "" ? undefined : assistantName}
          call={call ?? undefined}
          // Unlike the turns, this is drawn whether or not the exchange on the
          // card is this surface's own: the question it answers is whether the
          // assistant is busy, and it is busy on someone else's conversation just
          // as much as on this one.
          working={working}
          // Its own prop rather than something the surface derives from the
          // phase. The phase above is outranked by `typing` and `call`, and the
          // indicator and the control that ends the session are not: they
          // belong to the session, not to whatever the pill is drawing over it.
          watching={watching}
          // Its own prop rather than something derived from the phase, for the
          // reason `watching` is: a call or an open composer outranks the
          // phase, and a question the user has been asked must not lose its
          // answer because they picked up the phone.
          watchRetro={watchRetro}
          // Out through main and into the window that ran the retrospective. A
          // yes raises the app on the report; a no leaves the window where it
          // is. Neither is handled here: this page has no conversation and no
          // router, and the answer has to reach the side holding the question
          // or the prompt comes back on the next push.
          onWatchRetro={answerCompanionWatchRetro}
          // The reads that session has taken, which is what turns a running
          // session into something the user can see happening rather than
          // something they are told is on.
          captureCount={captureCount}
          // The flag, from main. It hides the way into a session and leaves
          // everything a running one draws alone, so a session already going
          // when the flag turns off can still be seen and still be stopped.
          watchEnabled={watchEnabled}
          // Draws the control the beat is about as though the pointer were on
          // it. The pill is open on those beats but the pointer is wherever the
          // user's hand happens to be, so without this the beat names a control
          // the user then has to hunt for among the others.
          spotlight={introSpotlight(intro)}
          // Beside the pill rather than inside it, on the canvas the typing
          // card would otherwise use. Null between runs, which is every launch
          // after the first.
          //
          // **Withdrawn, not ended, by a call or the composer.** Those states
          // rebuild the pill out of different controls, so a beat captioning
          // Talk would be labelling a control that is not on screen. Main
          // still holds the beat, so the run resumes where it was once the user
          // is done with whatever they were actually doing.
          intro={
            !introShown || intro === null ? null : (
              <CompanionIntro
                beat={intro}
                growth={growth}
                cardGrowth={cardGrowth}
                accentHex={accentHex}
                // Same undefined-not-empty rule as the composer's placeholder
                // above: the first beat introduces the creature by name, and
                // before the app's window has published one there is no name to
                // introduce it by.
                assistantName={assistantName === "" ? undefined : assistantName}
                cardRef={introRef}
                onAdvance={advanceCompanionIntro}
              />
            )
          }
          rootRef={pillRef}
          onSurfaceMouseDown={(event) => {
            // A right-click is a menu, not a grab. Left alone it would arm the
            // drag and then never be released by a `mouseup` this window sees,
            // because the menu takes the pointer for as long as it is open.
            if (event.button !== 0) {
              return;
            }
            dragRef.current = { x: event.screenX, y: event.screenY };
            pressOriginRef.current = { x: event.screenX, y: event.screenY };
            draggedRef.current = false;
          }}
          onSurfaceContextMenu={(event) => {
            // **Text keeps its own menu.** A right-click in the composer, or
            // on a reply the user has selected, wants Cut/Copy/Paste and the
            // spelling suggestions the host already provides. Swallowing that
            // to offer "Small / Medium / Large" would take away the only way
            // to copy something off this card.
            const target = event.target as HTMLElement | null;
            const onEditable =
              target?.closest("input, textarea, [contenteditable='true']") !==
              null;
            const onSelection =
              (window.getSelection()?.toString().trim().length ?? 0) > 0;
            if (onEditable || onSelection) {
              return;
            }
            event.preventDefault();
            // Main pops the menu at the pointer, so the window has to still be
            // clickable when it does. It is: the pointer is on the pill, which
            // is the only thing that makes this window interactive at all.
            showCompanionContextMenu();
          }}
          // A press that never became a drag. The window comes forward on the
          // conversation this surface belongs to; main decides what that means.
          onAvatarClick={() => {
            if (draggedRef.current) {
              return;
            }
            activateCompanionApp();
          }}
          // The press leaves this window immediately: the session lives in the
          // renderer holding the chat layout, and this page only asks for one.
          // What comes back is `call`, once that renderer has a session to
          // report.
          onTalk={startCompanionVoice}
          // One press for both edges, and it leaves this window the way Talk
          // does: the session lives in the renderer holding the chat layout,
          // and this page only asks for it. What comes back is `watching`.
          onWatch={toggleCompanionWatch}
          // Type opens the composer here rather than leaving this window, since
          // the field it opens is on this surface. What leaves is the message.
          onType={() => {
            setTyping(true);
          }}
          // Out through main and into whichever renderer holds a conversation to
          // put it in. **The card stays open**, because this is where the answer
          // arrives: the turns mirror pushes the sent message back within the
          // frame and the reply behind it, so the whole exchange reads here
          // rather than in an app the user deliberately did not go back to.
          onSubmit={(message) => {
            // The first message of a composer's life starts the conversation and
            // the rest continue it. The old tail is dropped on the way out rather
            // than left to be replaced, so the card never shows the previous
            // conversation's words underneath the one just sent.
            if (!started) {
              setTurns([]);
              setStarted(true);
            }
            submitCompanionMessage(message, !started);
          }}
          onCancelTyping={closeComposer}
          // Out through main and back down into whichever renderer holds the
          // session. This page has no session to act on: it draws one.
          onControl={(action, requestId) => {
            sendVoiceActivityControl(
              requestId === undefined ? { action } : { action, requestId },
            );
          }}
        />
      </div>
    </div>
  );
}
