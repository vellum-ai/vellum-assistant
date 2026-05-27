// Transcript scroll utilities — single home for the imperative
// replacement of `useDeprecatedTranscriptScroll`. Everything in this
// file is gated internally by `TRANSCRIPT_SCROLL_CONTROLLER_ENABLED`
// so callers in component files never branch on the flag themselves.
//
// In the current shape of this work-in-progress:
//
//   • Flag OFF (default) — the orchestrator runs the deprecated hook
//     `useDeprecatedTranscriptScroll`, which is the existing
//     production scroll-coordination logic. The utilities exported
//     from this file no-op in OFF, so callers can wire them at the
//     final shape today without affecting shipping behavior.
//   • Flag ON  — the deprecated hook returns its no-op result and the
//     utilities here take over piecewise as features migrate. The
//     ON path is the baseline against which the eventual
//     `TranscriptScrollController` will be built.
//
// Why module-load read + reload-on-toggle:
//
//   • React forbids conditionally calling different hooks across
//     renders. By making the dispatch decision once at module-import
//     time (before any component mounts), the dispatcher resolves to a
//     single function identity for the entire page lifetime.
//   • Toggling without a reload would leave the DOM in an inconsistent
//     intermediate state (scroll listeners attached but no longer
//     handled, in-flight auto-pin timers orphaned). A page reload is
//     cheap and dev-only.
//
// Surface (exposed under `window._vellumDebug.flags`):
//
//   toggleTranscriptScrollController()       — flip current value
//   toggleTranscriptScrollController(true)   — force on
//   toggleTranscriptScrollController(false)  — force off

import { useCallback, type MutableRefObject } from "react";

const STORAGE_KEY = "vellumDebug.flags.transcriptScrollController";

/** Read the flag synchronously. Safe to call at module-load time. */
export function getTranscriptScrollControllerEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // Private-browsing modes or sandboxed contexts can throw on
    // localStorage access. Treat any throw as "flag off".
    return false;
  }
}

/** Persist the flag, log the new value, and reload the page so the
 *  dispatcher re-resolves. `value === undefined` flips the current
 *  value (the most common interactive case). */
export function setTranscriptScrollControllerEnabled(value?: boolean): boolean {
  if (typeof window === "undefined") return false;
  const next =
    value === undefined ? !getTranscriptScrollControllerEnabled() : !!value;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Persistence failed — log and bail so the user knows their
    // toggle didn't stick.
    console.warn(
      "[vellumDebug] failed to persist transcriptScrollController flag",
    );
    return getTranscriptScrollControllerEnabled();
  }
  console.info(
    `[vellumDebug] transcriptScrollController = ${next} — reloading…`,
  );
  window.location.reload();
  return next;
}

/** The flag value resolved exactly once at module load. The
 *  dispatcher reads this constant so hook-rule order stays stable
 *  across the page lifetime. */
export const TRANSCRIPT_SCROLL_CONTROLLER_ENABLED =
  getTranscriptScrollControllerEnabled();

// ---------------------------------------------------------------------------
// Imperative scroll utilities
// ---------------------------------------------------------------------------
//
// The utilities below are the imperative replacements that piecewise
// take over from `useDeprecatedTranscriptScroll`. They listen to DOM
// lifecycle events (element attached, scroll, resize) rather than
// reacting to React state changes, which is the whole point of the
// migration — see `/workspace/scratch/scroll-imperative-spec.md`.

/** React key for the transcript scroll container element. Combine
 *  with `useTranscriptScrollContainerRef` on the same element so a
 *  conversation switch — or a fresh page load on a conversation
 *  detail route — triggers a fresh DOM attach. That attach is the
 *  event our callback ref listens for to scroll to the latest message.
 *
 *  Returns `undefined` when the controller flag is OFF, which
 *  preserves the deprecated-hook era reconciliation (no remount on
 *  conversation switch; the deprecated hook handles switching via
 *  its own conversation-id effect). */
export function getTranscriptScrollContainerKey(
  conversationId: string | null | undefined,
): string | undefined {
  if (!TRANSCRIPT_SCROLL_CONTROLLER_ENABLED) return undefined;
  return conversationId ?? "empty";
}

/** Callback ref for the transcript scroll container `<div>`. Forwards
 *  the attached element to `forwardTo` so existing imperative callers
 *  (pull-to-refresh, debug API, the transcript's own
 *  `useImperativeHandle`) keep working.
 *
 *  When the controller flag is ON, additionally scrolls to bottom on
 *  attach. Combined with `getTranscriptScrollContainerKey()` on the
 *  same element, this is the imperative implementation of
 *  "open every conversation view at the latest message" — feature #4
 *  in the migration tracker. The trigger is the DOM attach event, not
 *  a React state change. */
export function useTranscriptScrollContainerRef(
  forwardTo: MutableRefObject<HTMLDivElement | null>,
): (el: HTMLDivElement | null) => void {
  return useCallback(
    (el: HTMLDivElement | null) => {
      forwardTo.current = el;
      if (!TRANSCRIPT_SCROLL_CONTROLLER_ENABLED) return;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    },
    [forwardTo],
  );
}
