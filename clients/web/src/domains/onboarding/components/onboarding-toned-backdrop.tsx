/**
 * Persistent decorative backdrop for the later onboarding steps (the pitch
 * pages, integration, "let's chat tomorrow", and the research results).
 *
 * SPIKE — research-onboarding flow.
 *
 * Rendered once by the route and kept mounted across those steps, so the
 * assistant's color, its eyes peeking at the bottom, and the crowd of
 * characters peeking in around the edges all stay put while the foreground
 * content swaps — making the sequence feel like one continuous scene.
 *
 * `peekLevel` controls how many edge characters are revealed: the route bumps
 * it up one per step, so the crowd grows as onboarding progresses.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { OnboardingPeekingEyes } from "@/domains/onboarding/components/onboarding-peeking-eyes";
import { useOnboardingStageSize } from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import { pickOverlayColors } from "@/domains/onboarding/onboarding-avatar-colors";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

/**
 * The crowd that peeks in around the edges, in reveal order. The first few sit
 * across the top + sides so even a small count looks balanced; later ones fill
 * the corners. `base` is the size in px before the small-screen `peekScale`.
 * `pos` returns the cut-off offsets (negative / percentage) so each character
 * is clipped by the viewport edge — the "peeking in" look.
 */
// Revealed one-per-message during the looking-you-up carousel. Kept off the top
// (the persistent team lives there) and spread evenly across the left, right,
// and bottom edges. The first four — what the carousel reveals — are balanced
// left / right / bottom-left / bottom-right.
const PEEKERS: {
  bodyShape: string;
  eyeStyle: string;
  colorIdx: number;
  base: number;
  pos: (s: number) => Record<string, number | string>;
  /**
   * Kept on narrow screens, where the content fills the middle and most of the
   * width. `mobilePos` rides the four corners (clear of the content) so the
   * crowd spreads into the corners instead of bunching along the bottom.
   */
  mobile?: boolean;
  mobilePos?: (s: number) => Record<string, number | string>;
}[] = [
  { bodyShape: "sprout", eyeStyle: "curious", colorIdx: 0, base: 230, pos: (s) => ({ left: -s * 0.32, top: "40%" }) },
  { bodyShape: "flower", eyeStyle: "goofy", colorIdx: 1, base: 230, pos: (s) => ({ right: -s * 0.32, top: "40%" }) },
  { bodyShape: "star", eyeStyle: "dazed", colorIdx: 2, base: 240, mobile: true, pos: (s) => ({ left: "16%", bottom: -s * 0.42 }), mobilePos: (s) => ({ left: -s * 0.3, bottom: -s * 0.3 }) },
  { bodyShape: "burst", eyeStyle: "angry", colorIdx: 0, base: 240, mobile: true, pos: (s) => ({ right: "16%", bottom: -s * 0.42 }), mobilePos: (s) => ({ right: -s * 0.3, bottom: -s * 0.3 }) },
  { bodyShape: "blob", eyeStyle: "gentle", colorIdx: 1, base: 220, pos: (s) => ({ left: "42%", bottom: -s * 0.5 }) },
  { bodyShape: "urchin", eyeStyle: "curious", colorIdx: 2, base: 220, mobile: true, pos: (s) => ({ left: -s * 0.28, bottom: "16%" }), mobilePos: (s) => ({ left: -s * 0.3, top: -s * 0.3 }) },
  { bodyShape: "burst", eyeStyle: "quirky", colorIdx: 0, base: 220, mobile: true, pos: (s) => ({ right: -s * 0.28, bottom: "16%" }), mobilePos: (s) => ({ right: -s * 0.3, top: -s * 0.3 }) },
  { bodyShape: "flower", eyeStyle: "quirky", colorIdx: 1, base: 230, pos: (s) => ({ left: "30%", bottom: -s * 0.4 }) },
];

const DARK_SURFACE = "#17191C";

/** The team that peeks in from the top, persisting once it forms. */
const TOP_TEAM = [
  { bodyShape: "blob", eyeStyle: "gentle" },
  { bodyShape: "urchin", eyeStyle: "curious" },
  { bodyShape: "star", eyeStyle: "goofy" },
];
const TOP_TEAM_SIZE = 290;

export function OnboardingTonedBackdrop({
  peekLevel = 0,
  eyesBumpNonce = 0,
  darkBg = false,
  showBottomEyes = true,
  showTopTeam = false,
}: {
  /** How many edge characters to reveal — grows one per onboarding step. */
  peekLevel?: number;
  /** Increment to make the bottom eyes jolt (Mario bump on the coin). */
  eyesBumpNonce?: number;
  /** Blend the background from the avatar color to black (after the calendar). */
  darkBg?: boolean;
  /** Show the giant eyes peeking from the bottom (off once they've collapsed). */
  showBottomEyes?: boolean;
  /** Show the little team peeking in from the top edge (off by default). */
  showTopTeam?: boolean;
}) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const reduce = useReducedMotion();
  const { w } = useOnboardingStageSize();
  // Shrink the peeking characters on smaller screens (full size ≥ ~1100px wide).
  const peekScale = Math.max(0.42, Math.min(w / 1100, 1));
  // On narrow screens the content fills the middle, so the crowd retreats to a
  // smaller, corner-only set (see PEEKERS `mobile` / `mobilePos`).
  const isMobile = w < 640;

  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;

  const { bg, peekColors } = useMemo(() => {
    const fallback = { bg: "var(--surface-base)", peekColors: [] as string[] };
    if (!components || !chosen) return fallback;
    const color = components.colors.find((c) => c.id === chosen.color);
    return {
      bg: color?.hex ?? "var(--surface-base)",
      peekColors: pickOverlayColors(
        chosen.color,
        components.colors.map((c) => c.id),
        3,
      ),
    };
  }, [components, chosen]);

  return (
    <>
      <motion.div
        className="absolute inset-0 z-0"
        initial={false}
        animate={{ backgroundColor: darkBg ? DARK_SURFACE : bg }}
        transition={reduce ? { duration: 0 } : { duration: 1, ease: "easeInOut" }}
      />

      {/* The assistant's eyes peek up from the bottom (until they collapse into
          the small avatar at the calendar step). */}
      {showBottomEyes && (
        <OnboardingPeekingEyes bumpNonce={eyesBumpNonce} settleBlink={false} />
      )}

      {/* The team peeks in from the top-right — three larger avatars, overlapping
          and cut off by the top edge. Forms on the integration step and stays put. */}
      {showTopTeam && components && (
        <div
          className="pointer-events-none absolute right-0 z-[1] flex items-start"
          style={{
            top: -Math.round(TOP_TEAM_SIZE * peekScale) * 0.42,
            right: -Math.round(TOP_TEAM_SIZE * peekScale) * 0.12,
          }}
        >
          {TOP_TEAM.map((m, i) => {
            const size = Math.round(TOP_TEAM_SIZE * peekScale);
            return (
              <motion.div
                key={m.bodyShape}
                style={{
                  width: size,
                  height: size,
                  marginLeft: i === 0 ? 0 : -size * 0.34,
                  zIndex: TOP_TEAM.length - i,
                }}
                initial={reduce ? false : { y: -140, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 200, damping: 18, delay: i * 0.1 }
                }
              >
                <AnimatedAvatar
                  components={components}
                  traits={{
                    bodyShape: m.bodyShape,
                    eyeStyle: m.eyeStyle,
                    color: peekColors[i] ?? "teal",
                  }}
                  size={size}
                  breathe={false}
                />
              </motion.div>
            );
          })}
        </div>
      )}

      {/* The crowd peeks in around the edges — more reveal as steps progress.
          On narrow screens the side/top peekers crowd the content, so only the
          ones rising from the bottom edge are kept. */}
      {components && (
        <AnimatePresence>
          {(isMobile ? PEEKERS.filter((p) => p.mobile) : PEEKERS)
            .slice(0, Math.max(0, peekLevel))
            .map((p, i) => {
            const size = Math.round(p.base * peekScale);
            const position =
              isMobile && p.mobilePos ? p.mobilePos(size) : p.pos(size);
            return (
              <motion.div
                key={`peek-${i}`}
                aria-hidden="true"
                className="pointer-events-none absolute z-[1]"
                style={{ ...position, width: size, height: size }}
                initial={reduce ? false : { scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={reduce ? undefined : { scale: 0, opacity: 0 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 220, damping: 16, delay: 0.1 }
                }
              >
                <AnimatedAvatar
                  components={components}
                  traits={{
                    bodyShape: p.bodyShape,
                    eyeStyle: p.eyeStyle,
                    color: peekColors[p.colorIdx] ?? "teal",
                  }}
                  size={size}
                  breathe={false}
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
      )}
    </>
  );
}
