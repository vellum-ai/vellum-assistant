/**
 * The empty chat screen's avatar peek (Figma: New-App 7471-25035 /
 * 7471-25213). One avatar, rendered with its real body shape and eyes
 * (`AnimatedAvatar`), that lives behind the chat input and comes out
 * from behind two different edges of it:
 *
 * - **Intro**: on arriving at an empty chat it comes out from behind the
 *   input's bottom edge, off toward the right and hanging upside down
 *   the way a body hangs off a ledge, holds a beat, and tucks back up.
 *   A hello, played once per empty state.
 * - **Resting**: behind the input, dropped far enough that the clip
 *   column hides it completely.
 * - **Focused** (the input is active): it rises over the input's top
 *   rim instead, anchored toward the left, its lower half still behind
 *   the card, while the input casts a soft unoffset shadow over it so
 *   the body reads as sitting behind.
 *
 * The two perches never overlap in time: the intro owns the avatar
 * until it has ducked away, and only then does focus start driving the
 * top peek. Because the handoff happens while the avatar is hidden, it
 * is a swap between two clip columns rather than a path between them.
 *
 * The composer is located by its `data-slot="chat-composer"` anchor and
 * its rect tracked per-frame, so the overlay stays glued through
 * reflows and composer remounts. Rendered into a `document.body`
 * portal, decorative and pointer-transparent. Fully suppressed under
 * `prefers-reduced-motion` and while the in-chat onboarding tour owns
 * the chrome.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { recordUpdate } from "@/lib/commit-pressure";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { avatarPeekMetrics } from "@/utils/avatar-peek-metrics";

interface TargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Both perches derive their crop from `avatarPeekMetrics`, which reports
 * where the active body shape and eye style actually place the eye ink,
 * so every avatar shows its eyes past the rim it is peeking over. Bodies
 * whose face sits low (a lot of body above the eyes) get scaled DOWN
 * instead of exposing an ever taller slab, capping the on-screen height.
 */

/** Largest square the peek avatar renders at. */
const PEEK_SIZE_MAX = 100;
/** Cap on how much of it sticks out past the input's edge. */
const PEEK_EXPOSED_MAX_PX = 52;
/** Air between the eye ink and the input's rim. */
const PEEK_EYE_PAD_FRAC = 0.03;
/** Fallback exposure when metrics can't resolve (custom avatars). */
const PEEK_EXPOSED_FRAC_FALLBACK = 0.46;
/** Clip-column headroom past the exposed avatar, room for the idle
 *  breathing pulse. */
const CLIP_HEADROOM = 14;
/** Focus-peek anchor along the input's width, off toward the left. */
const PEEK_X_FRACTION = 0.15;
/** Intro anchor along the input's width, off toward the right. */
const INTRO_X_FRACTION = 0.85;
/** How much of the square hides behind the input during the intro, when
 *  metrics can't resolve. */
const INTRO_HIDDEN_FRAC_FALLBACK = 0.5;
/** How long the intro stays up, measured from the first rect. Covers the
 *  rise delay, the rise, and the hold. */
const INTRO_HOLD_MS = 3000;
/** The duck back down, after which focus takes over the avatar. */
const INTRO_RETREAT_MS = 300;
/** The composer card's own radius, matched by the shadow caster. */
const PANEL_RADIUS = 10;
/** Soft, unoffset shadow the input casts over the peeking avatar, so the
 *  body reads as sitting behind the card. */
const PEEK_SHADOW = "0 0 20px rgba(0, 0, 0, 0.15)";

interface ComposerPeekProps {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  /** True while the empty state is the visible view; false tears down. */
  active: boolean;
}

export function ComposerPeek({
  components,
  traits,
  active,
}: ComposerPeekProps) {
  const reduce = useReducedMotion();
  // The onboarding tour floods the composer itself — never compete with it.
  const navTourActive = useInChatOnboardingStore.use.navTourActive();
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [focused, setFocused] = useState(false);
  const [introRisen, setIntroRisen] = useState(false);
  const [introDone, setIntroDone] = useState(false);

  const runnable =
    active && !reduce && !navTourActive && !!components && !!traits;

  // Where this avatar's eye ink sits in its rendered square — drives the
  // per-shape crop/size below so the eyes always ride the edge.
  const metrics = useMemo(
    () => (components && traits ? avatarPeekMetrics(components, traits) : null),
    [components, traits],
  );

  useEffect(() => {
    if (!runnable) {
      return;
    }

    // Re-queried on every measure, never captured: the composer form
    // remounts (e.g. as a draft conversation settles), and a held
    // reference would go stale — a detached node measures 0×0 and the
    // overlay would freeze on the pre-remount rect.
    const measure = (): TargetRect | null => {
      const r = document
        .querySelector<HTMLElement>('[data-slot="chat-composer"]')
        ?.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) {
        return null;
      }
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    const enter = () => setFocused(true);
    const leave = () => setFocused(false);
    // Document-level so listeners survive composer remounts. Focus moving
    // within the composer (textarea → mic button) isn't a leave — only
    // retract when it lands outside the card.
    const onFocusIn = (event: FocusEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-slot="chat-composer"]')
      ) {
        enter();
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      const from =
        event.target instanceof Element &&
        event.target.closest('[data-slot="chat-composer"]');
      const to =
        event.relatedTarget instanceof Element &&
        event.relatedTarget.closest('[data-slot="chat-composer"]');
      if (from && !to) {
        leave();
      }
    };
    // The composer moves and resizes under the peek without firing any
    // event we could subscribe to — the centered empty-state group reflows
    // as the greeting streams in, the textarea autogrows, slots settle.
    // Track its rect every frame, scheduling an update only on a frame where
    // the rect actually moved. An unconditional per-frame `setRect` still
    // enters the commit stream whenever the fiber already has pending lanes
    // (React's eager bailout only applies to an idle fiber), which is exactly
    // the traffic that trips the nested-update limit. See
    // docs/CONVENTIONS.md, "Keep decorative animation out of the commit
    // stream".
    let raf = 0;
    let last: TargetRect | null = null;
    const track = () => {
      const next = measure();
      if (
        next &&
        (last === null ||
          next.left !== last.left ||
          next.top !== last.top ||
          next.width !== last.width ||
          next.height !== last.height)
      ) {
        last = next;
        recordUpdate("composer-peek");
        setRect(next);
      }
      raf = requestAnimationFrame(track);
    };
    raf = requestAnimationFrame(track);

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    // The composer may already hold focus when the act arms (it autofocuses
    // on a fresh chat), so record it. The intro still holds the avatar
    // until it has ducked away.
    if (
      document.activeElement instanceof Element &&
      document.activeElement.closest('[data-slot="chat-composer"]')
    ) {
      enter();
    }

    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      cancelAnimationFrame(raf);
      setRect(null);
      setFocused(false);
      setIntroRisen(false);
      setIntroDone(false);
    };
  }, [runnable]);

  // The intro runs off the first rect, since that's when the avatar first
  // has an edge to peek over. It always runs to completion: a fresh chat
  // autofocuses its composer, so gating on focus would skip it outright.
  const measured = rect !== null;
  useEffect(() => {
    if (!measured) {
      return;
    }
    setIntroRisen(true);
    const retreat = setTimeout(() => setIntroRisen(false), INTRO_HOLD_MS);
    const done = setTimeout(
      () => setIntroDone(true),
      INTRO_HOLD_MS + INTRO_RETREAT_MS,
    );
    return () => {
      clearTimeout(retreat);
      clearTimeout(done);
    };
  }, [measured]);

  // `components`/`traits` re-checked for narrowing — `runnable` implies both.
  if (!runnable || !rect || !components || !traits) {
    return null;
  }

  // Focus-peek geometry: expose down to just below the eye ink, capped.
  // Low-faced bodies scale down rather than exposing a taller slab.
  const peekExposedFrac = metrics
    ? Math.min(
        0.95,
        Math.max(
          0.25,
          metrics.eyeCenterFrac + metrics.eyeHalfFrac + PEEK_EYE_PAD_FRAC,
        ),
      )
    : PEEK_EXPOSED_FRAC_FALLBACK;
  const peekSize = Math.min(
    PEEK_SIZE_MAX,
    PEEK_EXPOSED_MAX_PX / peekExposedFrac,
  );
  const peekExposedPx = peekSize * peekExposedFrac;
  const clipHeight = peekExposedPx + CLIP_HEADROOM;
  // Resting drop: more than the exposed height, so the avatar clears the
  // column's bottom edge entirely and reads as behind the card.
  const risePx = peekExposedPx + 8;
  const peekX = Math.max(peekSize / 2 + 16, rect.width * PEEK_X_FRACTION);

  // Intro geometry. The avatar hangs mirrored, so the fraction that tucks
  // behind the input is measured from the square's BOTTOM: flipping puts
  // the eye ink at `1 - eyeCenterFrac`, and the cut lands just past it so
  // the eyes clear the rim. What hangs below is capped like the focus peek.
  const introHiddenFrac = metrics
    ? Math.min(
        0.85,
        Math.max(
          0.05,
          1 - metrics.eyeCenterFrac - metrics.eyeHalfFrac - PEEK_EYE_PAD_FRAC,
        ),
      )
    : INTRO_HIDDEN_FRAC_FALLBACK;
  const introBelowPx = peekSize * (1 - introHiddenFrac);
  const introClipHeight = Math.min(introBelowPx, PEEK_EXPOSED_MAX_PX);
  const introHidePx = -(introBelowPx + 8);
  const introX = Math.min(
    rect.width - peekSize / 2 - 16,
    rect.width * INTRO_X_FRACTION,
  );

  const showing = introDone ? focused : introRisen;

  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-30">
      {introDone ? (
        /* Focus peek: a column above the input, clipped at its top rim so
           the body reads as peeking out from behind the card.

           Keyed apart from the intro column so React remounts rather than
           reconciling the two branches into one element. Without the keys
           the swap keeps the same `motion.div`, `initial` never re-applies,
           and Motion tweens `y` from the intro's hidden value to this one,
           sweeping the avatar down through the column on its way. */
        <div
          key="focus-peek"
          className="absolute overflow-hidden"
          style={{
            left: rect.left,
            top: rect.top - clipHeight,
            width: rect.width,
            height: clipHeight,
          }}
        >
          <motion.div
            className="absolute"
            style={{
              width: peekSize,
              height: peekSize,
              left: peekX - peekSize / 2,
              top: clipHeight - peekExposedPx,
            }}
            initial={{ y: risePx }}
            animate={focused ? { y: 0 } : { y: risePx }}
            transition={
              focused
                ? { type: "spring", stiffness: 280, damping: 14, delay: 0.15 }
                : { duration: 0.25, ease: "easeIn" }
            }
          >
            <AnimatedAvatar
              components={components}
              traits={traits}
              size={peekSize}
            />
          </motion.div>
        </div>
      ) : (
        /* Intro: the mirror column, below the input and clipped at its
           bottom rim, so the same avatar comes out of the other edge. */
        <div
          key="intro-peek"
          className="absolute overflow-hidden"
          style={{
            left: rect.left,
            top: rect.top + rect.height,
            width: rect.width,
            height: introClipHeight,
          }}
        >
          <motion.div
            className="absolute"
            style={{
              width: peekSize,
              height: peekSize,
              left: introX - peekSize / 2,
              top: -peekSize * introHiddenFrac,
            }}
            initial={{ y: introHidePx }}
            animate={introRisen ? { y: 0 } : { y: introHidePx }}
            transition={
              introRisen
                ? { type: "spring", stiffness: 260, damping: 16, delay: 0.35 }
                : { duration: INTRO_RETREAT_MS / 1000, ease: "easeIn" }
            }
          >
            {/* Inner wrapper carries the vertical mirror so it can't
                interact with the motion `y` transform above (a flipped
                element's translateY would slide the wrong way). */}
            <div className="h-full w-full" style={{ transform: "scaleY(-1)" }}>
              <AnimatedAvatar
                components={components}
                traits={traits}
                size={peekSize}
              />
            </div>
          </motion.div>
        </div>
      )}
      {/* Shadow caster painted over the avatar: a transparent rect
          matching the card whose box-shadow falls on everything around
          it, so the avatar sits under the input's shadow and reads as
          behind. */}
      <motion.div
        className="absolute"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          borderRadius: PANEL_RADIUS,
          boxShadow: PEEK_SHADOW,
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: showing ? 1 : 0 }}
        transition={{ duration: 0.2 }}
      />
    </div>,
    document.body,
  );
}
