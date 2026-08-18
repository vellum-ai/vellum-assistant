/**
 * The empty chat screen's avatar peeks (Figma: New-App 7471-25035 /
 * 7471-25213). The avatar renders with its real body shape and eyes
 * (`AnimatedAvatar`), and where it idles depends on the shell:
 *
 * - **Resting, browser** (input not focused): a big avatar hangs down
 *   from the top edge of the screen, eyes half cut off by the edge with
 *   the rest of the body exposed, breathing and blinking over the
 *   chrome.
 * - **Resting, native mobile**: no top perch. Native shells draw under
 *   the system status area, which can cover that avatar's eyes, so the
 *   avatar says hello once from behind the input's bottom edge, off
 *   toward the right and hanging upside down off the rim, then tucks
 *   back up and stays behind the card.
 * - **Focused** (the input is active): on both shells the avatar
 *   surfaces over the input's top edge, its lower half hidden behind
 *   the rim, while the input casts a soft unoffset shadow over it so
 *   the body reads as sitting behind the card. This peek is anchored
 *   toward the input's left side, and starts above the mobile settings
 *   pills whenever that row reaches far enough left to sit between it
 *   and the card. In the browser the top dude retreats up off screen as
 *   it rises.
 *
 * On phone-sized windows the focus peek gives way to any banner docked
 * over the input's top edge (billing, setup, a draft notice): the banner
 * owns that strip, and an avatar rising into it would surface behind the
 * banner with its eyes cut off. The composer's mobile settings row stands
 * down on the same signal, which it publishes on the shell.
 *
 * The composer card is located by its `data-slot="chat-composer"` anchor
 * and its rect tracked per-frame, so the overlays stay glued through
 * reflows and composer remounts. Focus, though, is judged against the
 * wider `data-slot="chat-composer-shell"` wrapper, which also holds the
 * controls that float outside the card. Rendered into a `document.body`
 * portal, decorative and pointer-transparent. Fully suppressed under
 * `prefers-reduced-motion` and while the in-chat onboarding tour owns
 * the chrome.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { recordUpdate } from "@/lib/commit-pressure";
import { useIsNativeMobile } from "@/runtime/platform-detection";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { useMobileDrawerStore } from "@/stores/mobile-drawer-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { avatarPeekMetrics } from "@/utils/avatar-peek-metrics";

interface TargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The card's own computed `border-radius`, so the shadow caster below
   *  can trace whatever corner the card is currently wearing. */
  radius: string;
  /** How far above the card's top edge the focus peek has to start, so it
   *  clears the settings pills floating there. Zero whenever no row is up, or
   *  whenever the row hangs clear of the avatar's own column. */
  pillsClearance: number;
  /** True while a banner is docked over the card's top edge. */
  bannerAbove: boolean;
}

/** The composer card itself, which the overlays are measured against. */
const COMPOSER_SELECTOR = '[data-slot="chat-composer"]';
/** The wrapper around the card, which also holds controls that float
 *  outside it (the mobile settings pills). */
const COMPOSER_SHELL_SELECTOR = '[data-slot="chat-composer-shell"]';
/** Those pills, while they are up. The row stays mounted when it is away, so
 *  the `hidden` attribute is what separates the two. */
const COMPOSER_PILLS_SELECTOR =
  '[data-slot="composer-settings-pills"]:not([hidden])';
/** Marks a shell whose card currently has a banner standing over it.
 *  `ChatComposer` watches that stack for its own settings row and publishes
 *  the answer here, so this overlay reads one flag instead of keeping a
 *  second read of the same boxes on a different clock. */
const BANNER_ABOVE_ATTRIBUTE = "data-banner-above";

/**
 * Whether a focus target belongs to the composer. The shell is the
 * boundary, so tapping a pill floating above the card is not a leave.
 */
function withinComposer(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) {
    return false;
  }
  return Boolean(node.closest(COMPOSER_SHELL_SELECTOR));
}

/**
 * The left edge of the leftmost pill actually on screen, in viewport px, or
 * `null` for a row with nothing in it. The row itself spans the card's full
 * width and hangs its pills off the right end, so its own rect says nothing
 * about where the pills start.
 */
function leftmostPillEdge(row: HTMLElement): number | null {
  let leftmost: number | null = null;
  for (const pill of Array.from(row.children)) {
    const { left, width } = pill.getBoundingClientRect();
    if (width === 0) {
      continue;
    }
    if (leftmost === null || left < leftmost) {
      leftmost = left;
    }
  }
  return leftmost;
}

/**
 * Every perch derives its crop from `avatarPeekMetrics`, which reports
 * where the active body shape and eye style actually place the eye ink,
 * so every avatar shows its eyes at the edge. Bodies whose face sits low
 * (a lot of body above the eyes) get scaled DOWN instead of exposing an
 * ever taller slab, capping each perch's on-screen height.
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
/** Soft, unoffset shadow the input casts over the peeking avatar, so the
 *  body reads as sitting behind the card. */
const PEEK_SHADOW = "0 0 20px rgba(0, 0, 0, 0.15)";

/** Where the focus peek's avatar centres along the card's width, kept off the
 *  card's left edge by half its own width plus a margin. */
function peekAnchorX(cardWidth: number, peekSize: number): number {
  return Math.max(peekSize / 2 + 16, cardWidth * PEEK_X_FRACTION);
}

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

/** Intro anchor along the input's width, off toward the right. */
const INTRO_X_FRACTION = 0.85;
/** How much of the square hides behind the input during the intro, when
 *  metrics can't resolve. */
const INTRO_HIDDEN_FRAC_FALLBACK = 0.5;
/** How long the intro stays up, measured from the first rect. Covers the
 *  rise delay, the rise, and the hold. */
const INTRO_HOLD_MS = 3000;
/** The duck back up, after which focus takes over the avatar. */
const INTRO_RETREAT_MS = 300;

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
  // Native shells can place the system status area over the top perch.
  // Browsers keep it; native mobile gets the bottom-edge hello instead.
  const nativeMobile = useIsNativeMobile();
  // The window-size axis, for the banner rule below: it is a question of the
  // room left over the card, and the settings row that competes for the same
  // strip is gated the same way. See `docs/PLATFORM_ADAPTATION.md`.
  const isMobile = useIsMobile();
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [mode, setMode] = useState<Mode>("rest");
  const [introRisen, setIntroRisen] = useState(false);
  const [introDone, setIntroDone] = useState(false);

  // The drawer covers the chat page but cannot cover this: the peek renders
  // from a `document.body` portal, so it sits in a different stacking context
  // and its z-index never competes with the drawer's. Stand down instead.
  //
  // Deliberately not part of `runnable`: that would tear down the tracking
  // effect, whose cleanup clears `introDone`, and the hello would replay in
  // full every time the drawer was dismissed on the same empty chat. The
  // drawer hides the peek, it does not end the act, so it gates the render
  // below and leaves the lifecycle alone.
  const drawerPresented = useMobileDrawerStore.use.presented();

  const runnable =
    active && !reduce && !navTourActive && !!components && !!traits;

  // Where this avatar's eye ink sits in its rendered square — drives the
  // per-shape crop/size below so the eyes always ride the edge.
  const metrics = useMemo(
    () => (components && traits ? avatarPeekMetrics(components, traits) : null),
    [components, traits],
  );

  // Input peek geometry: expose down to just below the eye ink, capped, so
  // low-faced bodies scale down rather than exposing a taller slab. Derived up
  // here because the tracking effect needs the square's size to tell whether
  // the avatar's column runs into the pills row.
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

  useEffect(() => {
    if (!runnable) {
      return;
    }
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    // The pills row hides itself the instant focus leaves (`hidden` is
    // `display: none`), while this avatar is still playing its exit off the rim
    // it rose from. These two carry the row's clearance through that exit, or
    // the clip would lose the row's height in a single frame and drop the
    // avatar mid-animation.
    let exiting = false;
    let heldPillsClearance = 0;

    // Re-queried on every measure, never captured: the composer form
    // remounts (e.g. as a draft conversation settles), and a held
    // reference would go stale — a detached node measures 0×0 and the
    // overlay would freeze on the pre-remount rect.
    const measure = (): TargetRect | null => {
      const element =
        document.querySelector<HTMLElement>(COMPOSER_SELECTOR) ?? null;
      const r = element?.getBoundingClientRect();
      if (!element || !r || r.width === 0 || r.height === 0) {
        return null;
      }
      // Read alongside the rect, which has already flushed layout: the
      // caster has to trace the card's real corner, and the card is a
      // 10px panel on desktop and a deep pill on mobile.
      const radius = window.getComputedStyle(element).borderRadius;
      // The mobile settings pills float between the card and this avatar, so
      // where they run into its column the peek starts above the row instead.
      // The row hangs its pills off the card's right edge while this avatar
      // rises on the left, so a short row leaves the rim clear and the peek
      // stays on it, rather than floating a body height above nothing.
      const shell = element.closest<HTMLElement>(COMPOSER_SHELL_SELECTOR);
      const pills = shell?.querySelector<HTMLElement>(COMPOSER_PILLS_SELECTOR);
      // Height comes from layout, not from a rect: the row rises into place on
      // a transform, and a rect's top would move with it and put a `setRect` in
      // every frame of that animation. The same animation is translateY-only,
      // which leaves horizontal edges steady enough to read from a rect.
      const pillsLeft = pills ? leftmostPillEdge(pills) : null;
      const overlapsPills =
        pillsLeft !== null &&
        r.left + peekAnchorX(r.width, peekSize) + peekSize / 2 > pillsLeft;
      const measuredClearance =
        pills && overlapsPills
          ? pills.offsetHeight +
            (Number.parseFloat(window.getComputedStyle(pills).marginBottom) ||
              0)
          : 0;
      // Tracks the last measured value, zero included: holding only non-zero
      // ones would let a blur taken after the row stopped overlapping (or
      // unmounted) apply a stale clearance and teleport the exiting avatar up.
      if (!exiting) {
        heldPillsClearance = measuredClearance;
      }
      const pillsClearance =
        measuredClearance || (exiting ? heldPillsClearance : 0);
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        radius,
        pillsClearance,
        bannerAbove: shell?.hasAttribute(BANNER_ABOVE_ATTRIBUTE) ?? false,
      };
    };
    const enter = () => {
      clearTimeout(exitTimer);
      exiting = false;
      setMode("focus");
    };
    const leave = () => {
      setMode((m) => (m === "focus" ? "focus-exit" : m));
      clearTimeout(exitTimer);
      exiting = true;
      exitTimer = setTimeout(() => {
        exiting = false;
        setMode("rest");
      }, EXIT_MS);
    };
    // Document-level so listeners survive composer remounts. Focus moving
    // within the composer (textarea → mic button → a pill floating above
    // the card) isn't a leave: only retract when it lands outside the
    // whole composer.
    const onFocusIn = (event: FocusEvent) => {
      if (withinComposer(event.target)) {
        enter();
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      if (
        withinComposer(event.target) &&
        !withinComposer(event.relatedTarget)
      ) {
        leave();
      }
    };
    // The composer moves and resizes under the peeks without firing any
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
          next.height !== last.height ||
          next.radius !== last.radius ||
          next.pillsClearance !== last.pillsClearance ||
          next.bannerAbove !== last.bannerAbove)
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
    // on a fresh chat) — surface immediately instead of waiting for a blur
    // round-trip.
    if (withinComposer(document.activeElement)) {
      enter();
    }

    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      cancelAnimationFrame(raf);
      clearTimeout(exitTimer);
      setRect(null);
      setMode("rest");
      setIntroRisen(false);
      setIntroDone(false);
    };
    // `peekSize` is a number derived from the avatar's own metrics, so it holds
    // steady across the identity churn `components`/`traits` go through and
    // this act is not restarted (and its hello replayed) on every render.
  }, [runnable, peekSize]);

  // The native mobile hello runs off the first rect, when the avatar first
  // has an edge to peek over. It always runs to completion: a fresh chat
  // autofocuses its composer, so gating it on focus would skip it.
  const introReady = nativeMobile && rect !== null;
  useEffect(() => {
    if (!introReady) {
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
  }, [introReady]);

  // `components`/`traits` re-checked for narrowing — `runnable` implies both.
  if (!runnable || drawerPresented || !rect || !components || !traits) {
    return null;
  }

  const focused = mode === "focus";
  // A banner docks to the card's top edge and takes the strip this peek rises
  // into, so the avatar would surface behind it with its eyes cut off. Held
  // down rather than unmounted, so a banner that arrives mid-focus sends it
  // back the way a blur does. Phone-sized windows only, which is the shape
  // this was reported on and the one the settings row is already gated to.
  const peekRisen = focused && !(isMobile && rect.bannerAbove);
  // The hello owns the avatar until it has ducked away, so the focus peek
  // stays out of the way rather than putting a second one on screen.
  const introActive = nativeMobile && !introDone;

  // The rest of the input peek's geometry, off the size derived above.
  const peekExposedPx = peekSize * peekExposedFrac;
  const clipHeight = peekExposedPx + CLIP_HEADROOM;
  const risePx = peekExposedPx + 8;
  const peekX = peekAnchorX(rect.width, peekSize);

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

  // Intro geometry. The avatar hangs mirrored off the input's bottom rim,
  // so the fraction that tucks behind the card is measured from the
  // square's BOTTOM: flipping puts the eye ink at `1 - eyeCenterFrac`, and
  // the cut lands just past it so the eyes clear the rim. That is the same
  // formula the top perch uses against the screen edge.
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

  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-30">
      {!nativeMobile && (
        /* Top-of-screen dude, shown while the input is idle. */
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
      )}
      {introActive && (
        /* The native mobile hello: a mirror column below the input, clipped
           at its bottom rim, so the avatar comes out of the other edge.

           Keyed apart from the focus peek below so React remounts rather
           than reconciling the two into one element. Without the keys a
           shared `motion.div` would keep its state, `initial` would never
           re-apply, and Motion would tween `y` from this perch's hidden
           value to the other's, sweeping the avatar across the seam. */
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
            {/* Same reason as the top perch: the mirror rides an inner
                wrapper so it can't fight the motion `y` transform. */}
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
      {mode !== "rest" && !introActive && (
        /* Input-peek avatar, clipped at the input's top edge, or at the
           settings pills' where that row runs into its column, so the body
           reads as peeking out from behind whichever rim is nearest. */
        <div
          key="focus-peek"
          className="absolute overflow-hidden"
          style={{
            left: rect.left,
            top: rect.top - rect.pillsClearance - clipHeight,
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
            animate={peekRisen ? { y: 0 } : { y: risePx }}
            transition={
              peekRisen
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
      )}
      {/* Shadow caster painted over the avatar: a transparent rect
          matching the card whose box-shadow falls on everything around
          it, so the avatar sits under the input's shadow and reads as
          behind. Covers both the hello and the focus peek. */}
      <motion.div
        className="absolute"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          borderRadius: rect.radius,
          boxShadow: PEEK_SHADOW,
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: (introActive ? introRisen : peekRisen) ? 1 : 0 }}
        transition={{ duration: 0.2 }}
      />
    </div>,
    document.body,
  );
}
