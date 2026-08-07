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
import type { CompanionSurfaceState } from "@vellumai/ipc-contract";

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
 * Bring Vellum forward on the conversation the user was last in, which is what
 * pressing the avatar asks for.
 *
 * The one call here that deliberately raises the app. Everything else on the
 * surface exists so the user does not have to.
 */
export function activateCompanionApp(): void {
  bridge()?.activate?.();
}
