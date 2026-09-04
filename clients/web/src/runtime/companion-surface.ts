/**
 * Runtime wrapper for the always-present companion surface
 * (`clients/macos/src/main/companion-window.ts`).
 *
 * **Skew contract, as with every bridge surface here.** Every call no-ops off
 * Electron and on a shell that predates the channel, and nothing throws. The
 * surface is decoration on a desktop it does not own; it must never be the
 * reason something fails.
 */

import { isElectron } from "@/runtime/is-electron";
import type {
  CompanionCapturePick,
  CompanionCaptureSources,
  CompanionContext,
  CompanionDictating,
  CompanionIntroAction,
  CompanionSurfaceState,
  DictationOfferAnswer,
  ScreenCaptureFrame,
  WatchCaptureTarget,
} from "@vellumai/ipc-contract";

type CompanionBridge = NonNullable<NonNullable<Window["vellum"]>["companion"]>;

const bridge = (): CompanionBridge | undefined => {
  if (!isElectron()) {
    return undefined;
  }
  return window.vellum?.companion;
};

/** The anchor main computed from where the window sits. */
export function getCompanionState(): Promise<CompanionSurfaceState | null> {
  const companion = bridge();
  if (!companion) {
    return Promise.resolve(null);
  }
  return companion.getState().catch(() => null);
}

export function subscribeCompanionState(
  callback: (state: CompanionSurfaceState) => void,
): () => void {
  const companion = bridge();
  if (!companion) {
    return () => {};
  }
  return companion.onState(callback);
}

/**
 * Tell main whether the pointer is over the pill.
 *
 * The window is click-through by default so the canvas does not swallow
 * presses meant for whatever is behind it. It becomes clickable only while the
 * pointer is actually on the surface, which is why the page has to report this
 * rather than main inferring it: only the page knows where the pill is drawn.
 */
export function setCompanionInteractive(interactive: boolean): void {
  bridge()?.setInteractive?.(interactive);
}

/**
 * Nudge the window by a pointer delta, for dragging the surface around.
 *
 * Deltas rather than an absolute position: the page is the side holding the
 * pointer, and main is the side that knows where the window currently is.
 */
export function moveCompanionBy(dx: number, dy: number): void {
  bridge()?.moveBy?.(dx, dy);
}

/**
 * Ask for a live-voice session, which is what Talk does.
 *
 * The surface is a renderer of its own with no session in it, so the press is
 * handed to main and dispatched to the window that owns one. Nothing is
 * returned and nothing is awaited: whether a session actually starts is the
 * receiving window's decision, and the panel that surface opens is the answer
 * the user sees.
 */
export function startCompanionVoice(): void {
  bridge()?.startVoice?.();
}

/**
 * Turn the session that reads the screen on or off, which is what Watch does.
 *
 * One call for both edges, over the `COMPANION_TOGGLE_WATCH` channel, because
 * the surface draws one control and the window holding the session is the only
 * side that knows which edge a press is. Like {@link startCompanionVoice} the
 * press leaves this renderer immediately and nothing is awaited: what comes
 * back is `watching` on the pushed state, once the window that owns the session
 * has one to report.
 *
 * `pick` is the row of the picker a start came from, when it came from one.
 * Main turns it into the session's target, so what comes back beside
 * `watching` is `captureTarget`, and the frame main draws around it.
 */
export function toggleCompanionWatch(pick?: CompanionCapturePick): void {
  bridge()?.toggleWatch?.(pick);
}

/**
 * What a session could read right now, for the picker Teach opens.
 *
 * Resolves to nothing at all off Electron and on a shell that predates the
 * picker, rather than to an empty list: an empty list is a desktop with no
 * windows on it, which is a different fact, and the surface reads nothing as
 * having no picker to draw.
 */
export function listCompanionCaptureSources(): Promise<CompanionCaptureSources | null> {
  const companion = bridge();
  if (!companion?.listCaptureSources) {
    return Promise.resolve(null);
  }
  return companion.listCaptureSources().catch(() => null);
}

/**
 * Show the running call what the user is looking at, or stop, which is what
 * the share control does.
 *
 * `pick` is the row of the picker the press came from; a press with none is
 * the stop. Like {@link toggleCompanionWatch} the press leaves this renderer
 * at once: main resolves a tab to the window showing it and hands the target
 * to the window holding the session, and what comes back is `screenShare` on
 * the pushed state once that window has frames flowing.
 */
export function setCompanionScreenShare(pick?: CompanionCapturePick): void {
  bridge()?.setScreenShare?.(pick);
}

/**
 * One frame of what the user is sharing, as the helper takes it.
 *
 * The one call in this module made from the app's own window on a cadence
 * rather than on a press: the session lives there, and each frame becomes a
 * `sight_frame` on it. Resolves to nothing off Electron, on a shell that
 * predates the share, and whenever the helper could not take one, and the
 * caller reads every one of those as a frame to skip.
 */
export function captureCompanionScreen(
  target: WatchCaptureTarget,
): Promise<ScreenCaptureFrame | null> {
  const companion = bridge();
  if (!companion?.captureScreen) {
    return Promise.resolve(null);
  }
  return companion.captureScreen(target).catch(() => null);
}

/**
 * Answer the question a finished watch session leaves on the surface: open its
 * summary now, or not.
 *
 * Both answers leave this renderer, including the dismissal. The window that
 * ran the retrospective is the one holding the question, so an answer kept here
 * would be a question that goes on being asked: the next state main pushes
 * would carry `watchRetro` still set and draw the prompt again.
 */
export function answerCompanionWatchRetro(open: boolean): void {
  bridge()?.answerWatchRetro?.(open);
}

/**
 * Answer the offer a dictation's words are standing on: use them in place of
 * what another app pasted, get that app off the key, take them to the
 * clipboard, or leave them. Every answer leaves this renderer, for the reason
 * the retro's does: the window that made the offer is the one holding it.
 *
 * The offer is named rather than assumed, since this window can be a frame
 * behind the one holding it. See {@link CompanionDictationOffer.id}.
 */
export function answerCompanionDictationOffer(
  answer: DictationOfferAnswer,
  offerId: string,
): void {
  bridge()?.answerDictationOffer?.(answer, offerId);
}

/**
 * Bring Vellum forward on the conversation the user was last in, which is what
 * pressing the avatar asks for.
 *
 * The one call here that deliberately raises the app. Everything else on the
 * surface exists so the user does not have to.
 */
export function activateCompanionApp(): void {
  bridge()?.activate?.();
}

/**
 * Publish the assistant's name and what the app's window knows about the turn
 * and the sessions it is running.
 *
 * The one call in this module made from the app's own window rather than from
 * the surface's route: the surface holds none of it, so the window that does
 * has to hand it over. Main holds it and pushes it back down with the rest of
 * the surface's state.
 */
export function setCompanionContext(context: CompanionContext): void {
  lastContext = context;
  bridge()?.setContext?.(context);
}

/**
 * The last context published, so {@link clearCompanionWorking} can correct one
 * field of it without its caller having to hold the rest.
 */
let lastContext: CompanionContext | null = null;

/**
 * Stop claiming a turn is in flight.
 *
 * `working` is the one part of the context that is a claim about right now.
 * Main deliberately holds the last context it was given so the surface survives
 * its own renderer reloading, and the name is worth holding that way because
 * it describes something settled. A retained `working: true` describes
 * something that is happening, and a publisher going away does not make it so.
 *
 * It has to be said rather than inferred. The surface is opened by main, from
 * the assistant it has and the user's tray preference, not by the window
 * publishing to it, so it stays on screen with nothing left to report the turn
 * ending and the ring would travel indefinitely.
 *
 * Lives here rather than with the publisher because this is the module that
 * owns the channel, and the callers that need it at teardown are outside the
 * chat domain: `handleLogout` replaces the page synchronously on the non-local
 * path, so no React cleanup runs. Same reason `setAssistantName("")` is called
 * there.
 */
/**
 * Correct what the running dictation is doing and saying, and nothing else.
 *
 * A recogniser revises its guess several times a second, and each revision is
 * a fact about the microphone rather than about the conversation. Rebuilding
 * the whole context for one would reselect and remap the conversation's tail
 * on every word, so this reuses the last one and replaces the two fields that
 * moved, the way {@link clearCompanionWorking} does for the turn.
 *
 * Silent until a context has been published, since there is nothing to correct
 * and a dictation with no assistant beside it is not a card the surface draws.
 */
export function setCompanionDictation(
  dictating: CompanionDictating | undefined,
  dictationText: string,
): void {
  if (lastContext === null) {
    return;
  }
  if (
    lastContext.dictating === dictating &&
    (lastContext.dictationText ?? "") === dictationText
  ) {
    return;
  }
  setCompanionContext({ ...lastContext, dictating, dictationText });
}

export function clearCompanionWorking(): void {
  if (lastContext === null || !lastContext.working) {
    return;
  }
  setCompanionContext({ ...lastContext, working: false });
}

/**
 * Move the surface's one-time introduction on, or end it.
 *
 * Which beat that lands on is main's to work out: it holds the run, so the
 * press names a direction rather than a destination and a press sent from a
 * renderer a beat behind cannot walk it backwards.
 */
export function advanceCompanionIntro(action: CompanionIntroAction): void {
  bridge()?.advanceIntro?.(action);
}

/**
 * Ask main to open the surface's own menu at the pointer.
 *
 * The renderer knows a right-click happened and nothing else: the menu is a
 * native window, and the size and visibility it acts on are main's.
 */
export function showCompanionContextMenu(): void {
  bridge()?.showContextMenu?.();
}
