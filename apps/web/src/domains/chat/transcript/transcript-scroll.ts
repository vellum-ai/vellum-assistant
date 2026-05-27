// Transcript scroll utilities — the imperative replacement for
// `useDeprecatedTranscriptScroll`. Listens to DOM lifecycle events
// (element attached, content resized, user gesture) rather than
// reacting to React state changes. Full spec lives at
// `/workspace/scratch/scroll-imperative-spec.md`.
//
// Gating against `TRANSCRIPT_SCROLL_CONTROLLER_ENABLED` lives inside
// each utility's body so component files import them without
// branching on the flag themselves.

import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
} from "react";

import {
  TRANSCRIPT_SCROLL_CONTROLLER_ENABLED,
  getTranscriptScrollControllerEnabled,
} from "@/domains/chat/transcript/transcript-scroll-flag";

/** Pixel threshold for "near the top" — matches the value the
 *  deprecated hook used so user-facing behavior is preserved. */
const NEAR_TOP_LOAD_OLDER_PX = 200;

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
  /** Whether more older history is available. Used by the load-older
   *  effect to decide whether to attach a `ResizeObserver`. */
  hasMore?: boolean;
  /** Whether an older-page fetch is currently in flight. When true,
   *  the effect tears down its `ResizeObserver`; when false again,
   *  the effect re-runs and a fresh observer's initial tick covers
   *  the chain-load case. */
  isLoadingOlder?: boolean;
  /** Callback fired when the `ResizeObserver` detects the scroll
   *  position is near the top. */
  onLoadOlder?: () => void;
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

  // Load-older wiring. A `useEffect` (not a state-mirror ref) is the
  // right shape here: when `hasMore`, `isLoadingOlder`, or
  // `onLoadOlder` change, the effect tears down and re-attaches with
  // fresh closures — no `latestRef` pattern, no stale-snapshot bug
  // shape from the deprecated hook.
  //
  // While `isLoadingOlder` is true the observer is intentionally
  // detached: once it flips back to false the effect re-runs, a fresh
  // observer's initial tick measures the post-prepend layout, and
  // chain-loads continue automatically when the viewport is still
  // underfilled.
  const { hasMore, isLoadingOlder, onLoadOlder } = args;
  useEffect(() => {
    // Read the flag at effect-run time (not module-load). The effect
    // is an early-return guard, not a hook dispatch site, so there's
    // no rules-of-hooks concern with a dynamic check here. Side
    // benefit: integration tests can flip the flag via `localStorage`
    // without fighting module-import ordering.
    if (!getTranscriptScrollControllerEnabled()) return;
    if (!hasMore || isLoadingOlder || !onLoadOlder) return;
    const container = args.scrollContainerRef.current;
    const content = args.contentRef.current;
    if (!container || !content) return;
    return attachLoadOlderOnTop({ container, content, onLoadOlder });
  }, [
    args.scrollContainerRef,
    args.contentRef,
    hasMore,
    isLoadingOlder,
    onLoadOlder,
  ]);

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

/**
 * Trigger `onLoadOlder()` whenever a `ResizeObserver` tick on the
 * content reports the scroll container is within
 * `NEAR_TOP_LOAD_OLDER_PX` of the top.
 *
 * Pure imperative function — no React, no saved state, no anchor.
 * The hook owns when to attach (only when `hasMore && !isLoadingOlder`)
 * and tears down on prop change, so this function only needs to act
 * on every observed tick.
 *
 * Covers, by construction:
 *   • **Initial chain-load** — `observe()` fires once with current
 *     measurements; if the freshly attached transcript is already
 *     near the top (typically because it's underfilled), older
 *     history is requested.
 *   • **Repeat chain-load** — when an older page lands, the parent
 *     flips `isLoadingOlder` false, the hook re-runs the effect, a
 *     fresh observer's initial tick measures the new layout, and the
 *     loop continues until the viewport is full or `hasMore` flips.
 *   • **Streaming-triggered detection** — any content height change
 *     while the user is near the top fires the observer.
 *
 * Does NOT cover, intentionally:
 *   • User scrolling up to the top with no other content change.
 *     Scroll events do not fire a `ResizeObserver`. Adding a scroll
 *     listener belongs to a separate PR (Trigger A in the migration
 *     spec).
 */
export function attachLoadOlderOnTop(args: {
  container: HTMLElement;
  content: HTMLElement;
  onLoadOlder: () => void;
}): () => void {
  const { container, content, onLoadOlder } = args;

  if (typeof ResizeObserver === "undefined") {
    return () => {};
  }

  const observer = new ResizeObserver(() => {
    if (container.scrollTop > NEAR_TOP_LOAD_OLDER_PX) return;
    onLoadOlder();
  });
  observer.observe(content);

  return () => observer.disconnect();
}
