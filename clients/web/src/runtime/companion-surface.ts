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
  CompanionContext,
  CompanionIntroAction,
  CompanionSurfaceState,
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
 */
export function toggleCompanionWatch(): void {
  bridge()?.toggleWatch?.();
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
 * Tell main whether the composer is open, which is how long the window may
 * hold the keyboard.
 *
 * The keyboard twin of {@link setCompanionInteractive}, and reported from here
 * for the same reason: main owns the window but only the page knows whether
 * there is a field on screen to type into. A surface that kept key status after
 * its field closed would eat the next thing the user typed into the app they
 * are working in.
 */
export function setCompanionComposing(composing: boolean): void {
  bridge()?.setComposing?.(composing);
}

/**
 * Send what the user typed on the surface.
 *
 * Like {@link startCompanionVoice}, the message is handed to main and
 * dispatched to the window that owns a conversation to put it in. Nothing is
 * awaited: this page has no transport, and the reply arrives where replies
 * always arrive.
 */
export function submitCompanionMessage(
  message: string,
  startsConversation: boolean,
): void {
  bridge()?.submit?.(message, startsConversation);
}

/**
 * Publish the assistant's name and the tail of the open conversation.
 *
 * The one call in this module made from the app's own window rather than from
 * the surface's route: the surface holds neither, so the window that does has
 * to hand them over. Main holds them and pushes them back down with the rest of
 * the surface's state.
 */
export function setCompanionContext(context: CompanionContext): void {
  lastContext = context;
  bridge()?.setContext?.(context);
}

/**
 * The last context published, so {@link clearCompanionWorking} can correct one
 * field of it without its caller having to hold the conversation it was
 * published beside.
 */
let lastContext: CompanionContext | null = null;

/**
 * Stop claiming a turn is in flight.
 *
 * `working` is the one part of the context that is a claim about right now.
 * Main deliberately holds the last context it was given so the card survives
 * the surface's renderer reloading, and the tail and the name are worth holding
 * that way because they describe something that happened. A retained
 * `working: true` describes something that is happening, and a publisher going
 * away does not make it so.
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

/**
 * Hand a link from the card to the host, which opens it in the browser.
 *
 * The surface's window denies every navigation and every `window.open`, so an
 * anchor cannot follow itself and the shared `openExternalUrl` helper has
 * nothing to work with here. Main validates the scheme on the far side.
 */
export function openCompanionLink(url: string): void {
  bridge()?.openLink?.(url);
}
