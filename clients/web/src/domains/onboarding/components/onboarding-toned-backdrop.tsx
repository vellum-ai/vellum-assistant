/**
 * Persistent decorative backdrop for the later onboarding steps (talk style,
 * integration, "let's chat tomorrow").
 *
 * SPIKE — research-onboarding flow.
 *
 * Rendered once by the route and kept mounted across those steps, so the
 * assistant's color, its eyes peeking at the bottom, and the chosen tone
 * characters peeking at the top all stay put while the foreground content
 * swaps — making the sequence feel like one continuous scene.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { OnboardingPeekingEyes } from "@/domains/onboarding/components/onboarding-peeking-eyes";
import { pickOverlayColors } from "@/domains/onboarding/onboarding-avatar-colors";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import type { CharacterTraits } from "@/types/avatar";

export type TalkStyle = "simple" | "details";

/** One peeking character: traits, where/how big it pokes in, and timing. */
interface Peeker {
  traits: CharacterTraits;
  size: number;
  reveal: number;
  x: string;
  delay: number;
  flip: boolean;
  bob: boolean;
  z: number;
}

function useViewport() {
  const [size, setSize] = useState(() => ({
    w: typeof window === "undefined" ? 1280 : window.innerWidth,
    h: typeof window === "undefined" ? 800 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/**
 * Characters that peek in for a style. `scale` (0.42–1) shrinks them on smaller
 * screens so they fit on mobile.
 *   - simple → one large, calm, upside-down character (top-left).
 *   - details → three overlapping spiky characters clustered top-right that
 *     stagger in and bob, to convey "more".
 */
function peekersFor(style: TalkStyle, colors: string[], scale: number): Peeker[] {
  const s = (px: number) => Math.round(px * scale);
  if (style === "simple") {
    return [
      {
        traits: { bodyShape: "blob", eyeStyle: "gentle", color: colors[0] ?? "teal" },
        size: s(380),
        reveal: 0.5,
        x: "20%",
        delay: 0,
        flip: true,
        bob: false,
        z: 1,
      },
    ];
  }
  // Three spiky characters (lots of edges), tightly overlapping, staggered.
  return [
    {
      traits: { bodyShape: "burst", eyeStyle: "quirky", color: colors[1] ?? "purple" },
      size: s(300),
      reveal: 0.6,
      x: "72%",
      delay: 0.1,
      flip: false,
      bob: true,
      z: 1,
    },
    {
      traits: { bodyShape: "urchin", eyeStyle: "curious", color: colors[0] ?? "teal" },
      size: s(340),
      reveal: 0.66,
      x: "80%",
      delay: 0,
      flip: false,
      bob: true,
      z: 3,
    },
    {
      traits: { bodyShape: "star", eyeStyle: "dazed", color: colors[2] ?? "yellow" },
      size: s(300),
      reveal: 0.6,
      x: "88%",
      delay: 0.2,
      flip: false,
      bob: true,
      z: 2,
    },
  ];
}

export function OnboardingTonedBackdrop({
  talkStyle,
  eyesBumpNonce = 0,
}: {
  talkStyle: TalkStyle | null;
  /** Increment to make the bottom eyes jolt (Mario bump on the coin). */
  eyesBumpNonce?: number;
}) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const reduce = useReducedMotion();
  const { w } = useViewport();
  // Shrink the tone characters on smaller screens (full size ≥ ~1100px wide).
  const peekScale = Math.max(0.42, Math.min(w / 1100, 1));

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
      <div
        className="absolute inset-0 z-0"
        style={{ backgroundColor: bg }}
      />

      {/* The assistant's eyes peek up from the bottom. */}
      <OnboardingPeekingEyes bumpNonce={eyesBumpNonce} />

      {/* The chosen tone's character(s) peek in from the top and stay. */}
      {components && (
        <AnimatePresence>
          {talkStyle &&
            peekersFor(talkStyle, peekColors, peekScale).map((peeker, i) => (
              <PeekingToneAvatar
                key={`${talkStyle}-${i}`}
                peeker={peeker}
                components={components}
                reduce={!!reduce}
              />
            ))}
        </AnimatePresence>
      )}
    </>
  );
}

/** A single character that peeks down from the top edge. */
function PeekingToneAvatar({
  peeker,
  components,
  reduce,
}: {
  peeker: Peeker;
  components: NonNullable<ReturnType<typeof useBundledAvatarComponents>>;
  reduce: boolean;
}) {
  const { traits, size, reveal, x, delay, flip, bob, z } = peeker;
  const peekY = -(1 - reveal) * size;

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed top-0 -translate-x-1/2"
      style={{ left: x, width: size, height: size, zIndex: z }}
      initial={reduce ? { y: peekY } : { y: -size }}
      animate={{ y: peekY }}
      exit={reduce ? { y: peekY } : { y: -size }}
      transition={
        reduce
          ? { duration: 0 }
          : bob
            ? { type: "spring", stiffness: 120, damping: 10, delay }
            : { type: "spring", stiffness: 340, damping: 30, delay }
      }
    >
      <motion.div
        style={flip ? { transform: "rotate(180deg)" } : undefined}
        animate={
          reduce || !bob ? undefined : { y: [0, -16, 0], rotate: [0, 3, -3, 0] }
        }
        transition={
          reduce || !bob
            ? undefined
            : {
                repeat: Infinity,
                duration: 2.4 + z * 0.2,
                ease: "easeInOut",
                delay: delay + 0.4,
              }
        }
      >
        <AnimatedAvatar components={components} traits={traits} size={size} />
      </motion.div>
    </motion.div>
  );
}
