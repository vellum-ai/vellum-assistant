import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import { StreamingShimmerText } from "@/domains/chat/components/streaming-shimmer-text";

/**
 * Animated tuple of (currentStepTitle, currentStepInfo) rendered inside
 * the collapsed header of a `ToolProgressCardShell`. Both texts animate
 * together via a single `AnimatePresence` keyed on the tuple identity so
 * the title + subtext never desync mid-transition.
 *
 * Variants mirror `WebsiteCarousel`'s recipe (top-down slide + opacity
 * fade) so the card-wide motion vocabulary stays consistent. Slightly
 * tighter `duration` since text labels feel snappier than chip swaps.
 *
 * Honours `prefers-reduced-motion` — falls back to an opacity-only fade
 * with duration 0.
 *
 * `currentStepInfo` accepts a `ReactNode` (not just a string) so callers
 * can pass rich content — e.g. the lone web-search link passes a
 * `<WebsiteCarousel />` in carousel mode while other consumers pass plain
 * text. The component compares `info` references via `Object.is` so memoised
 * nodes (e.g. the carousel) don't trigger a transition on every parent render.
 */

/**
 * Minimum dwell time (ms) for each step shown in the header carousel.
 *
 * Without this, fast-arriving streamed updates (Anthropic-native can emit
 * multiple result deltas inside ~100ms) would flash past as a blur. The
 * throttle hook below queues newer values and lands on the latest one
 * once the previous has been on-screen long enough to register.
 */
const HEADER_STEP_MIN_DWELL_MS = 400;

/**
 * Latch a value to its previous render until at least `minDwellMs` has
 * elapsed, then update to the latest pending value. Multiple updates inside
 * the window collapse into the final one — last value always wins.
 *
 * Used to throttle the header step (title + info tuple) so the user can
 * actually read each step before it transitions out, regardless of how
 * fast the daemon streams metadata.
 *
 * When `bypass` is `true`, the dwell is skipped entirely — the latest value
 * is applied synchronously on the next effect tick and any pending timer is
 * cancelled. Used by callers that need terminal-state values (e.g.
 * `complete`) to land immediately instead of trailing the loading-state
 * throttle.
 */
function useThrottledValue<T>(
  value: T,
  minDwellMs: number,
  bypass: boolean,
): T {
  const [displayed, setDisplayed] = useState(value);
  // `null` sentinel = "not yet initialised". Seeded lazily on the first
  // change so the initial render stays pure (no `Date.now()` during render).
  const lastChangeAt = useRef<number | null>(null);
  const pending = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Same value as on-screen → nothing to schedule.
    if (Object.is(displayed, value)) {
      pending.current = null;
      return;
    }
    // Bypass mode flushes immediately — terminal-state header content (e.g.
    // green check + "Searched the web") must appear in the same paint as
    // the icon swap, not 400ms later.
    if (bypass) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current = null;
      setDisplayed(value);
      lastChangeAt.current = Date.now();
      return;
    }
    pending.current = value;
    const nowMs = Date.now();
    if (lastChangeAt.current === null) {
      // First swap — anchor the dwell clock to "now" so the very first
      // transition still respects `minDwellMs`.
      lastChangeAt.current = nowMs;
    }
    const elapsed = nowMs - lastChangeAt.current;
    const wait = Math.max(0, minDwellMs - elapsed);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      // Land on whatever the latest pending value is — newer updates that
      // arrived while we were waiting will have overwritten it.
      if (pending.current !== null) {
        setDisplayed(pending.current);
        lastChangeAt.current = Date.now();
        pending.current = null;
      }
      timer.current = null;
    }, wait);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [value, displayed, minDwellMs, bypass]);

  return displayed;
}

export function HeaderStepCarousel({
  currentStepTitle,
  currentStepInfo,
  bypassDwell = false,
  animationKey,
  shimmer = false,
  inline = false,
}: {
  currentStepTitle: string;
  currentStepInfo: ReactNode;
  /**
   * When `true`, skip the 400ms minimum-dwell throttle and apply
   * `(currentStepTitle, currentStepInfo)` immediately on the next effect
   * tick. Used by callers entering a terminal state (e.g. `complete`,
   * `denied`, `error`) so the final header content paints in sync with
   * the status-icon swap instead of trailing it.
   *
   * Loading-state updates should leave this `false` so rapid streamed
   * metadata still coalesces into readable steps.
   */
  bypassDwell?: boolean;
  /**
   * Optional stable identity for the enter/exit transition. By default the
   * animation re-keys on the `(title, info)` tuple, so any text change slides
   * the old content out and the new content in. When the header's only
   * changing part is a live value (e.g. a ticking "Working for 8s"), pass a
   * constant key here so the same element stays mounted and the text updates
   * in place — no per-tick slide.
   */
  animationKey?: string;
  /**
   * When `true`, the primary header label (the title, or the promoted
   * title-less info text) renders through {@link StreamingShimmerText} — the
   * avatar-tinted gradient sweep that marks in-flight work. Secondary info
   * subtext stays plain.
   */
  shimmer?: boolean;
  /**
   * Inline (bare-header) mode, passed through from the shell's `bare`
   * variant. The primary label mirrors the inline `SingleActivity` link —
   * 13px medium in `--content-secondary`, flush left (no `ml-1`, since bare
   * headers render no leading status icon) — so the multi-activity header
   * reads as the same affordance family and left-aligns with the links
   * around it. Boxed cards (web search, subagent) keep the Typography
   * emphasised title.
   */
  inline?: boolean;
}) {
  const reduce = useReducedMotion();
  const tuple = useMemo(
    () => ({ title: currentStepTitle, info: currentStepInfo }),
    [currentStepTitle, currentStepInfo],
  );
  const displayed = useThrottledValue(
    tuple,
    HEADER_STEP_MIN_DWELL_MS,
    bypassDwell,
  );

  const transition = reduce
    ? { duration: 0 }
    : {
        duration: 0.25,
        ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
      };
  const initial = reduce ? { opacity: 0 } : { y: -16, opacity: 0 };
  const animate = reduce ? { opacity: 1 } : { y: 0, opacity: 1 };
  const exit = reduce ? { opacity: 0 } : { y: 16, opacity: 0 };

  // Stable per-frame key so identical sequential tuples don't trigger a
  // wasted transition. For string / number info we interpolate the value
  // directly; for ReactNode info we use a constant sentinel so the key
  // changes only with the title — the info node's own React identity
  // (preserved across renders by the caller via memoisation) drives
  // reconciliation of its subtree.
  const isTextInfo =
    typeof displayed.info === "string" || typeof displayed.info === "number";
  const infoKey = isTextInfo
    ? String(displayed.info)
    : displayed.info == null
      ? ""
      : "node";
  // A caller-supplied `animationKey` pins the transition identity so in-place
  // value updates (e.g. a ticking duration) don't trigger a slide; otherwise
  // the key tracks the content tuple so each new step animates in.
  const key = animationKey ?? `${displayed.title}::${infoKey}`;

  // Pipe separator only renders when there's info to follow it. Empty
  // string, null, and undefined all count as "no info".
  const hasInfo = isTextInfo ? displayed.info !== "" : displayed.info != null;

  // Some tools (e.g. bash) intentionally carry no collapsed-header title —
  // the info subtext alone is the label. When the title is empty we drop both
  // the title element and the leading pipe, and promote the info into the
  // primary (emphasised) slot so it doesn't read as de-emphasised subtext.
  const hasTitle = displayed.title.trim() !== "";

  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={key}
        initial={initial}
        animate={animate}
        exit={exit}
        transition={transition}
        // Header layout — flex row. With info present the title is a
        // non-shrinking anchor (shrink-0 + nowrap) and the info truncates in
        // the remaining space; when the title is the sole label it truncates
        // itself so a long one (e.g. an ACP command) can't overflow the row
        // and overlap the trailing controls.
        className="flex min-w-0 flex-1 items-center gap-1"
      >
        {hasTitle ? (
          inline ? (
            // typography: off-scale — pixel-matches the inline
            // `SingleActivity` label (13px medium, secondary) so the bare
            // multi-activity header reads as the same affordance.
            // `leading-[16px]` overrides the Button's `label-medium-default`
            // line-height of 1, which clips descenders (the "g" in
            // "Working") behind the shimmer/truncate overflow clipping.
            <span
              className={
                hasInfo
                  ? "shrink-0 whitespace-nowrap text-[13px] font-medium leading-[16px] text-[var(--content-secondary)]"
                  : "block min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-[16px] text-[var(--content-secondary)]"
              }
            >
              {shimmer ? (
                <StreamingShimmerText>{displayed.title}</StreamingShimmerText>
              ) : (
                displayed.title
              )}
            </span>
          ) : (
            <Typography
              variant="body-medium-default"
              className={
                hasInfo
                  ? "ml-1 shrink-0 whitespace-nowrap text-[var(--content-emphasised)]"
                  : "ml-1 block min-w-0 flex-1 truncate text-left text-[var(--content-emphasised)]"
              }
            >
              {shimmer ? (
                <StreamingShimmerText>{displayed.title}</StreamingShimmerText>
              ) : (
                displayed.title
              )}
            </Typography>
          )
        ) : null}
        {hasInfo ? (
          <>
            {hasTitle ? (
              // Vertical rule divider between title and info. A real 14px
              // rule (not a `|` glyph) so its height matches the labels'
              // cap height regardless of font metrics. `ml-1` mirrors the
              // info's own `ml-1` so the divider sits an even 8px
              // (row `gap-1` + 4px margin) from BOTH labels.
              <span
                aria-hidden="true"
                className="ml-1 h-3.5 w-px shrink-0 bg-[var(--border-element)]"
              />
            ) : null}
            {isTextInfo ? (
              inline && !hasTitle ? (
                // Title-less inline header: the info IS the primary label, so
                // it takes the same off-scale `SingleActivity`-matched style
                // as the inline title above (13px medium, secondary, flush
                // left — no `ml-1` since it's the row's first element).
                <span className="block min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-[16px] text-[var(--content-secondary)]">
                  {shimmer && typeof displayed.info === "string" ? (
                    <StreamingShimmerText>
                      {displayed.info}
                    </StreamingShimmerText>
                  ) : (
                    displayed.info
                  )}
                </span>
              ) : (
                <Typography
                  // With a title present, the info is subtext (small, tertiary).
                  // With no title it IS the header label, so it takes the
                  // title's emphasis (medium, emphasised) instead.
                  variant={
                    hasTitle ? "body-small-default" : "body-medium-default"
                  }
                  // `body-small-default` ships line-height: 1, which clips
                  // descenders (e.g. the "g" in "subagent") once `truncate`
                  // adds overflow:hidden. Bump to 16px — the same ~1.3 ratio
                  // the title's `body-medium-default` (18/14) uses — so the
                  // glyphs get vertical breathing room while staying centered.
                  // `ml-1` adds 4px on top of the row's `gap-1` (also 4px) so
                  // the descriptor sits ~8px clear of the `|` separator (or, when
                  // title-less, aligns where the title would have sat).
                  className={`ml-1 block min-w-0 flex-1 truncate text-left leading-[16px] ${
                    hasTitle
                      ? "text-[var(--content-tertiary)]"
                      : "text-[var(--content-emphasised)]"
                  }`}
                >
                  {/* When the info IS the primary label (title-less headers,
                      e.g. bash), the shimmer applies to it instead. */}
                  {shimmer &&
                  !hasTitle &&
                  typeof displayed.info === "string" ? (
                    <StreamingShimmerText>{displayed.info}</StreamingShimmerText>
                  ) : (
                    displayed.info
                  )}
                </Typography>
              )
            ) : (
              <span className="ml-1 block min-w-0 flex-1">
                {displayed.info}
              </span>
            )}
          </>
        ) : null}
      </motion.span>
    </AnimatePresence>
  );
}
