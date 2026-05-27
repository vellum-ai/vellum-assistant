// Transcript scroll utilities — the imperative replacement for
// `useDeprecatedTranscriptScroll`. Listens to DOM lifecycle events
// (element attached, content resized, user gesture) rather than
// reacting to React state changes. Full spec lives at
// `/workspace/scratch/scroll-imperative-spec.md`.
//
// Gating against `TRANSCRIPT_SCROLL_CONTROLLER_ENABLED` lives inside
// each utility's body so component files import them without
// branching on the flag themselves.

import { useCallback, useRef, type MutableRefObject } from "react";

import { TRANSCRIPT_SCROLL_CONTROLLER_ENABLED } from "@/domains/chat/transcript/transcript-scroll-flag";

/**
 * Wire the transcript scroll container + content callback refs.
 *
 * Behavior when the controller flag is ON:
 *   1. On scroll container DOM attach (which fires on conversation
 *      switch via `key={conversationId}` in `transcript.tsx`, and on
 *      fresh detail-page loads), the container is snapped to bottom.
 *   2. A `ResizeObserver` watches the content wrapper. Until the user
 *      interacts, every content height change re-snaps to bottom.
 *      This covers the seed-then-grow race where `useViewportMinHeight`
 *      seeds `LatestTurnRow`'s `minHeight` in a post-paint effect,
 *      growing `scrollHeight` after the initial attach snap.
 *   3. The first `wheel`/`touchmove`/`keydown` on the container
 *      disengages the observer — the user is now in control.
 *
 * When the controller flag is OFF, both callbacks forward to the
 * passed-in refs without observing or scrolling — the deprecated hook
 * still owns scroll coordination in that path.
 *
 * Both callbacks are returned as memoized identities so React doesn't
 * tear them down between renders. The internal state (observer +
 * gesture listeners) is keyed off element identity, not callback
 * identity, so the wiring survives parent re-renders and tears down
 * exactly when the underlying element changes.
 */
export function useTranscriptScrollOnAttach(args: {
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  contentRef: MutableRefObject<HTMLDivElement | null>;
}): {
  scrollContainerCallbackRef: (el: HTMLDivElement | null) => void;
  contentCallbackRef: (el: HTMLDivElement | null) => void;
} {
  // Refs for tearing down the previous attach when the element
  // changes (e.g. conversation switch with `key={conversationId}`).
  const teardownRef = useRef<(() => void) | null>(null);

  const teardown = useCallback(() => {
    teardownRef.current?.();
    teardownRef.current = null;
  }, []);

  const scrollContainerCallbackRef = useCallback(
    (el: HTMLDivElement | null) => {
      args.scrollContainerRef.current = el;
      // No work here — all setup waits for the content ref so we
      // can attach the ResizeObserver to the inner wrapper. The
      // content ref is guaranteed to fire on the same commit since
      // it's a child of this element.
    },
    [args.scrollContainerRef],
  );

  const contentCallbackRef = useCallback(
    (el: HTMLDivElement | null) => {
      args.contentRef.current = el;
      if (!TRANSCRIPT_SCROLL_CONTROLLER_ENABLED) return;

      // Tear down whatever was wired to the previous content/container.
      teardown();

      if (!el) return;
      const container = args.scrollContainerRef.current;
      if (!container) return;

      teardownRef.current = attachSnapToLatest({ container, content: el });
    },
    [args.scrollContainerRef, args.contentRef, teardown],
  );

  return { scrollContainerCallbackRef, contentCallbackRef };
}

/**
 * Snap the scroll container to bottom and keep it there through async
 * layout settling. Returns a teardown function that disconnects the
 * `ResizeObserver` and removes the gesture listeners.
 *
 * Pure imperative function — takes plain DOM elements, no React. The
 * React wiring lives in `useTranscriptScrollOnAttach`; this function
 * is independently testable with a fake `HTMLElement`.
 */
export function attachSnapToLatest(args: {
  container: HTMLElement;
  content: HTMLElement;
}): () => void {
  const { container, content } = args;

  // Initial attach snap — synchronous, during commit, before paint.
  container.scrollTop = container.scrollHeight;

  // Browsers without `ResizeObserver` get the initial snap only.
  // Modern browsers (and the iOS WKWebView) all have it; this guard
  // is for SSR / test environments.
  if (typeof ResizeObserver === "undefined") {
    return () => {};
  }

  let active = true;

  const stop = (): void => {
    if (!active) return;
    active = false;
    observer.disconnect();
    container.removeEventListener("wheel", stop);
    container.removeEventListener("touchmove", stop);
    container.removeEventListener("keydown", stop);
  };

  const observer = new ResizeObserver(() => {
    if (!active) return;
    container.scrollTop = container.scrollHeight;
  });
  observer.observe(content);

  // User-gesture disengage. The user touching the scroll container in
  // any way means they're driving — stop fighting them.
  container.addEventListener("wheel", stop, { passive: true });
  container.addEventListener("touchmove", stop, { passive: true });
  container.addEventListener("keydown", stop);

  return stop;
}
