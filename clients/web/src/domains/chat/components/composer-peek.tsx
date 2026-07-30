/**
 * The empty chat screen's avatar peeks (Figma: New-App 7471-25035 /
 * 7471-25213). The avatar renders with its real body shape and eyes
 * (`AnimatedAvatar`) in two perches:
 *
 * - **Resting** (input not focused): a big avatar hangs down from the
 *   top edge of the screen, eyes half cut off by the edge with the rest
 *   of the body exposed, breathing and blinking over the chrome.
 * - **Focused** (the input is active): the top dude retreats up off
 *   screen and the avatar surfaces over the input's top edge instead,
 *   its lower half hidden behind the rim, while the input casts a soft
 *   unoffset shadow over it so the body reads as sitting behind the
 *   card. This peek is anchored toward the input's left side.
 *
 * The composer is located by its `data-slot="chat-composer"` anchor and
 * its rect tracked per-frame, so the overlays stay glued through
 * reflows and composer remounts. Rendered into a `document.body`
 * portal, decorative and pointer-transparent. Fully suppressed under
 * `prefers-reduced-motion` and while the in-chat onboarding tour owns
 * the chrome.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
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
 * Both perches derive their crop from `avatarPeekMetrics` — where the
 * active body shape + eye style actually place the eye ink — so every
 * avatar shows its eyes at the edge. Bodies whose face sits low (a lot
 * of body above the eyes) get scaled DOWN instead of exposing an ever
 * taller slab, capping each perch's on-screen height.
 */

/** Largest square the input-peek avatar renders at. */
const PEEK_SIZE_MAX = 100;
/** Cap on how much of it sticks out above the input's top edge. */
const PEEK_EXPOSED_MAX_PX = 52;
/** Air between the eye ink's bottom and the input's rim. */
const PEEK_EYE_PAD_FRAC = 0.03;
/** Fallback exposure when metrics can't resolve (custom avatars). */
const PEEK_EXPOSED_FRAC_FALLBACK = 0.46;
/** Clip-container headroom above the exposed avatar — room for the idle
 *  breathing pulse. */
const CLIP_HEADROOM = 14;
/** Avatar anchor along the input's width — off toward the left side. */
const PEEK_X_FRACTION = 0.15;
/** Exit choreography length before the input-peek overlay unmounts. */
const EXIT_MS = 300;
/** The composer card's own radius — the shadow caster matches it. */
const PANEL_RADIUS = 10;
/** Soft, unoffset shadow the input casts over the peeking avatar, so the
 *  body reads as sitting behind the card. */
const PEEK_SHADOW = "0 0 20px rgba(0, 0, 0, 0.15)";

/** The top-of-screen dude, sized off the input width (Figma ~half). */
const TOP_SIZE_FRACTION = 0.45;
const TOP_SIZE_MIN = 220;
const TOP_SIZE_MAX = 360;
/** Cap on the visible dangle's height, whatever the body shape. */
const TOP_DANGLE_MAX_PX = 190;
/** Air between the screen edge and the (mirrored) eye ink's top. */
const TOP_EYE_PAD_FRAC = 0.02;
/** Fallback cut when metrics can't resolve. */
const TOP_CUT_FRACTION_FALLBACK = 0.5;

type Mode = "rest" | "focus" | "focus-exit";

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
  const [mode, setMode] = useState<Mode>("rest");

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
    let exitTimer: ReturnType<typeof setTimeout> | undefined;

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
    const enter = () => {
      clearTimeout(exitTimer);
      setMode("focus");
    };
    const leave = () => {
      setMode((m) => (m === "focus" ? "focus-exit" : m));
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => setMode("rest"), EXIT_MS);
    };
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
    // The composer moves and resizes under the peeks without firing any
    // event we could subscribe to — the centered empty-state group reflows
    // as the greeting streams in, the textarea autogrows, slots settle.
    // Track its rect every frame; the updater bails (same state object)
    // when nothing changed, so idle frames don't re-render.
    let raf = 0;
    const track = () => {
      setRect((prev) => {
        const next = measure();
        if (!next) {
          return prev;
        }
        if (
          prev &&
          next.left === prev.left &&
          next.top === prev.top &&
          next.width === prev.width &&
          next.height === prev.height
        ) {
          return prev;
        }
        return next;
      });
      raf = requestAnimationFrame(track);
    };
    raf = requestAnimationFrame(track);

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    // The composer may already hold focus when the act arms (it autofocuses
    // on a fresh chat) — surface immediately instead of waiting for a blur
    // round-trip.
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
      clearTimeout(exitTimer);
      setRect(null);
      setMode("rest");
    };
  }, [runnable]);

  // `components`/`traits` re-checked for narrowing — `runnable` implies both.
  if (!runnable || !rect || !components || !traits) {
    return null;
  }

  const focused = mode === "focus";

  // Input peek geometry: expose down to just below the eye ink, capped —
  // low-faced bodies scale down rather than exposing a taller slab.
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
  const risePx = peekExposedPx + 8;
  const peekX = Math.max(peekSize / 2 + 16, rect.width * PEEK_X_FRACTION);

  // Top dude geometry: centered over the input, hanging mirrored from
  // the screen's top edge with its eyes peering down just below the cut
  // and the visible dangle capped in height.
  const topCut = metrics
    ? Math.min(
        0.85,
        Math.max(
          0,
          1 - metrics.eyeCenterFrac - metrics.eyeHalfFrac - TOP_EYE_PAD_FRAC,
        ),
      )
    : TOP_CUT_FRACTION_FALLBACK;
  const topVisibleFrac = 1 - topCut;
  const topSize = Math.min(
    Math.min(
      TOP_SIZE_MAX,
      Math.max(TOP_SIZE_MIN, rect.width * TOP_SIZE_FRACTION),
    ),
    TOP_DANGLE_MAX_PX / topVisibleFrac,
  );
  const topExposed = topSize * topVisibleFrac;

  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-30">
      {/* Top-of-screen dude, shown while the input is idle. */}
      <motion.div
        className="absolute"
        style={{
          width: topSize,
          height: topSize,
          left: rect.left + rect.width / 2 - topSize / 2,
          top: -topSize * topCut,
        }}
        initial={{ y: -topExposed - 8 }}
        animate={{ y: focused ? -topExposed - 8 : 0 }}
        transition={
          focused
            ? { duration: 0.25, ease: "easeIn" }
            : { type: "spring", stiffness: 220, damping: 20, delay: 0.15 }
        }
      >
        {/* Inner wrapper carries the vertical mirror so it can't interact
            with the motion `y` transform above (a flipped element's
            translateY would slide the wrong way). */}
        <div className="h-full w-full" style={{ transform: "scaleY(-1)" }}>
          <AnimatedAvatar
            components={components}
            traits={traits}
            size={topSize}
          />
        </div>
      </motion.div>
      {mode !== "rest" && (
        <>
          {/* Input-peek avatar, clipped at the input's top edge so the
              body reads as peeking out from behind the rim. */}
          <div
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
                  ? {
                      type: "spring",
                      stiffness: 280,
                      damping: 14,
                      delay: 0.15,
                    }
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
          {/* Shadow caster painted over the avatar: a transparent rect
              matching the card whose box-shadow falls on everything around
              it — the avatar sits under the input's shadow, so it reads as
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
            animate={{ opacity: focused ? 1 : 0 }}
            transition={{ duration: 0.2 }}
          />
        </>
      )}
    </div>,
    document.body,
  );
}
