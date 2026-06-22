/**
 * "Introduction" step — the chosen avatar fills the screen and introduces
 * itself.
 *
 * SPIKE — research-onboarding flow.
 *
 * The body (in the avatar color) grows from the picker's size up to cover the
 * screen end to end, blending into a matching color background. The eyes peek
 * up from the bottom via the shared `OnboardingPeekingEyes` (grow-in entrance,
 * delayed behind the body so they're never seen below it). Once it settles, the
 * greeting bounces in with the Continue button.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { OnboardingPeekingEyes } from "@/domains/onboarding/components/onboarding-peeking-eyes";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

interface IntroductionScreenProps {
  firstName: string;
  onContinue: () => void;
  onBack: () => void;
}

/** Multiply each channel of a #rrggbb hex by `factor` (clamped). */
function darkenHex(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const ch = (shift: number) =>
    Math.max(0, Math.min(255, Math.round(((n >> shift) & 0xff) * factor)));
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/** The body grow starts from the picker's centered size / position. */
const PICKER_SIZE = 200;
const PICKER_CENTER_VH = 40;

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

export function IntroductionScreen({
  firstName,
  onContinue,
  onBack,
}: IntroductionScreenProps) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const reduce = useReducedMotion();
  const { w, h } = useViewport();
  const tone = useOnboardingTone();

  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;

  const art = useMemo(() => {
    if (!components || !chosen) return null;
    const body = components.bodyShapes.find((b) => b.id === chosen.bodyShape);
    const color = components.colors.find((c) => c.id === chosen.color);
    if (!body || !color) return null;
    return { body, color: color.hex };
  }, [components, chosen]);

  const greeting = firstName.trim()
    ? `Hi nice to meet you ${firstName.trim()}!`
    : "Hi nice to meet you!";

  if (!art) {
    return (
      <div
        data-theme="dark"
        className="h-full"
        style={{ backgroundColor: "var(--surface-base)" }}
      />
    );
  }

  const headingDark = darkenHex(art.color, 0.6);

  // Body grows to cover the screen end to end, starting from the picker size.
  const coverSize = 1.25 * Math.max(w, h);
  const coverH = (coverSize * art.body.viewBox.height) / art.body.viewBox.width;
  const bodyLeft = (w - coverSize) / 2;
  const bodyTop = (h - coverH) / 2;
  const bodyStartScale = PICKER_SIZE / coverSize;
  const bodyStartY = (PICKER_CENTER_VH / 100 - 0.5) * h; // start near picker center

  return (
    // Starts on the picker's dark surface; the color layer below fades in.
    <div
      data-theme="dark"
      className="relative h-full overflow-hidden"
      style={{ backgroundColor: "var(--surface-base)" }}
    >
      {/* The avatar color fills in so coverage is end-to-end even where the
          body shape has gaps/spikes. */}
      <motion.div
        className="absolute inset-0 z-0"
        style={{ backgroundColor: art.color }}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduce ? { duration: 0 } : { duration: 0.6, delay: 0.35 }}
      />

      {/* Body — grows from the picker size to cover the screen. */}
      <motion.svg
        aria-hidden="true"
        className="pointer-events-none absolute z-[1]"
        viewBox={`0 0 ${art.body.viewBox.width} ${art.body.viewBox.height}`}
        width={coverSize}
        height={coverH}
        style={{ left: bodyLeft, top: bodyTop, transformOrigin: "center" }}
        initial={reduce ? false : { scale: bodyStartScale, y: bodyStartY }}
        animate={{ scale: 1, y: 0 }}
        transition={
          reduce
            ? { duration: 0 }
            : { type: "spring", stiffness: 78, damping: 18, mass: 1 }
        }
      >
        <path d={art.body.svgPath} fill={art.color} />
      </motion.svg>

      {/* Eyes peek up from the bottom, growing in alongside the body. */}
      <OnboardingPeekingEyes entrance />

      {/* Progress + back — fade in after the grow. */}
      <motion.div
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduce ? { duration: 0 } : { duration: 0.4, delay: 1 }}
      >
        <OnboardingTopBar
          current={3}
          total={5}
          label="Introduction"
          onBack={onBack}
          onNext={onContinue}
        />
      </motion.div>

      {/* Greeting + Continue, grouped so the button sits just under the text. */}
      <div className="absolute left-1/2 top-[30%] z-10 flex -translate-x-1/2 flex-col items-center gap-8">
        <motion.h1
          className="text-center leading-[1.05]"
          style={{ fontFamily: "var(--font-serif)" }}
          initial={reduce ? false : { scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={
            reduce
              ? { duration: 0 }
              : { type: "spring", stiffness: 260, damping: 11, delay: 1 }
          }
        >
          <span
            className="block text-[clamp(2.5rem,6vw,5rem)]"
            style={{ color: headingDark }}
          >
            {greeting}
          </span>
          <span
            className="block text-[clamp(2.5rem,6vw,5rem)]"
            style={{ color: tone.fg }}
          >
            I&rsquo;m your new AI assistant.
          </span>
        </motion.h1>

        <motion.button
          type="button"
          onClick={onContinue}
          className="flex h-11 w-[234px] items-center justify-center gap-2 rounded-[10px] bg-black text-body-medium-default text-white transition-transform duration-150 active:scale-[0.97]"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.4, delay: 1.15 }}
        >
          Continue
          <ArrowRight className="h-4 w-4" />
        </motion.button>
      </div>
    </div>
  );
}
