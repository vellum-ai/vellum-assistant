/**
 * Two short "what makes me different" statement steps that sit between the
 * Introduction and the talk-style step.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground only — they render over the shared `OnboardingTonedBackdrop`
 * (assistant color + edge crowd). Both choreograph the assistant's bottom eyes
 * themselves, so the route hides the backdrop's resting pair on these steps and
 * each renders its own `MotionEyes`.
 *
 *   - PitchDifferentStep  eyes rise to "speak" the pitch in, then settle
 *   - PitchTogetherStep   a team forms; the eyes act out "smarter" and "faster"
 */

import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";

import {
  MotionEyes,
  useOnboardingEyes,
} from "@/domains/onboarding/components/onboarding-motion-eyes";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

const SETUP_LINE = "You’ve used AI that just answers questions";
const PUNCH_LINE = "I’m different";

/**
 * The assistant's eyes shoot straight up from the bottom (shrinking), speaking
 * line 1 into view bottom→top along the rise. They fly straight back down to
 * their resting peek with a small bounce, speaking "I'm different" in as they
 * pass over it, then blink twice. A Continue button then appears.
 */
export function PitchDifferentStep({
  onContinue,
  onBack,
  onForward,
}: {
  onContinue: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  const tone = useOnboardingTone();
  const reduce = useReducedMotion();
  const { art, eyesW, eyesH, restCy, centerX, w, h } = useOnboardingEyes();

  const line1Ref = useRef<HTMLSpanElement>(null);

  // The eyes' vertical center + scale, and how much of each line they've spoken
  // in (0→1). Line 1 reveals bottom→top as the eyes rise past it; line 2 reveals
  // top→bottom as they bounce back down past it.
  const eyeCy = useMotionValue(0);
  const eyeScale = useMotionValue(1);
  const reveal1 = useMotionValue(reduce ? 1 : 0);
  const reveal2 = useMotionValue(reduce ? 1 : 0);

  const [ready, setReady] = useState(false);
  const [landed, setLanded] = useState(reduce);
  const [blinking, setBlinking] = useState(false);

  // Line 1 wipes in bottom→top (top clipped until the rising eyes pass it); line
  // 2 wipes in top→bottom (bottom clipped until the descending eyes pass it).
  const clip1 = useTransform(reveal1, (r) => `inset(${(1 - r) * 100}% 0 -35% 0)`);
  const clip2 = useTransform(reveal2, (r) => `inset(-35% 0 ${(1 - r) * 100}% 0)`);

  // Park the eyes at rest until the journey starts (and, for reduced motion,
  // leave them there with the text already shown).
  useEffect(() => {
    eyeCy.set(restCy);
    setReady(true);
  }, [restCy, eyeCy]);

  useEffect(() => {
    if (reduce || !art) return;
    const l1 = line1Ref.current;
    if (!l1) return;
    const r1 = l1.getBoundingClientRect();

    const smallScale = 0.55; // up above the words
    const aboveCy = r1.top - 22 - (eyesH * smallScale) / 2; // clear above line 1

    eyeCy.set(restCy);
    eyeScale.set(1);
    reveal1.set(0);
    reveal2.set(0);

    const controls: ReturnType<typeof animate>[] = [];
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;
    const track = <T extends ReturnType<typeof animate>>(c: T): T => {
      controls.push(c);
      return c;
    };
    const wait = (ms: number) =>
      new Promise<void>((res) => {
        timeouts.push(setTimeout(res, ms));
      });
    const blink = async (hold = 120) => {
      setBlinking(true);
      await wait(hold);
      if (!cancelled) setBlinking(false);
    };

    const run = async () => {
      // Shoot straight up — fast and tight — painting line 1 in along the rise
      // (reveal locked to the rise via matching duration/ease).
      await Promise.all([
        track(animate(eyeCy, aboveCy, { duration: 0.55, ease: "easeOut", delay: 0.2 })),
        track(animate(eyeScale, smallScale, { duration: 0.55, ease: "easeOut", delay: 0.2 })),
        track(animate(reveal1, 1, { duration: 0.55, ease: "easeOut", delay: 0.2 })),
      ]);
      if (cancelled) return;
      // Drop back down with a little bounce, revealing "I'm different" — and bring
      // Continue in right alongside it.
      setLanded(true);
      await Promise.all([
        track(animate(eyeCy, restCy, { type: "spring", stiffness: 210, damping: 15 })),
        track(animate(eyeScale, 1, { duration: 0.45, ease: "easeOut" })),
        track(animate(reveal2, 1, { duration: 0.45, ease: "easeOut" })),
      ]);
      if (cancelled) return;
      // Settle with a couple of blinks.
      await blink();
      await wait(140);
      if (cancelled) return;
      await blink();
    };
    void run();

    return () => {
      cancelled = true;
      controls.forEach((c) => c.stop());
      timeouts.forEach(clearTimeout);
    };
  }, [reduce, art, w, h, eyesH, restCy, eyeCy, eyeScale, reveal1, reveal2]);

  return (
    <div className="absolute inset-0 z-10 overflow-hidden" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      {/* The assistant's eyes — behind the text, so the words read as lifted into
          view in front of them as the eyes rise. */}
      {ready && art && (
        <MotionEyes
          art={art}
          eyesW={eyesW}
          eyesH={eyesH}
          centerX={centerX}
          eyeCy={eyeCy}
          eyeScale={eyeScale}
          blinking={blinking}
        />
      )}

      <div className="absolute left-1/2 top-[32%] z-10 flex w-full max-w-3xl -translate-x-1/2 flex-col items-center gap-10 px-6 text-center">
        <h1
          className="text-[clamp(2.25rem,5.5vw,4.5rem)] leading-[1.15]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {/* Setup line — the darker secondary tone, matching "Hey {name}". */}
          <motion.span
            ref={line1Ref}
            className="block"
            style={{ color: tone.fgDeep, clipPath: clip1 }}
          >
            {SETUP_LINE}
          </motion.span>
          {/* Payoff — the full-strength foreground, with extra space above it. */}
          <motion.span
            className="mt-8 block"
            style={{ color: tone.fg, clipPath: clip2 }}
          >
            {PUNCH_LINE}
          </motion.span>
        </h1>

        {/* Continue appears once the eyes have settled back down. */}
        {landed && (
          <motion.button
            type="button"
            onClick={onContinue}
            className="flex h-11 w-[234px] items-center justify-center gap-2 rounded-[10px] bg-black text-body-medium-default text-white transition-transform duration-150 active:scale-[0.97]"
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.4 }}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </motion.button>
        )}
      </div>
    </div>
  );
}

const TOGETHER_HEADING = "The more we work together";
const SMARTER_LINE = "The smarter I get";
const FASTER_LINE = "The faster I can take things off your plate";

/**
 * The payoff: the relationship compounds. The heading lands and a little team of
 * avatars forms beneath it (and stays). Then the eyes act out each benefit — they
 * swell to "get smarter", then dash side to side to show how "fast" things move.
 */
export function PitchTogetherStep({
  onContinue,
  onBack,
  onForward,
}: {
  onContinue: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  const tone = useOnboardingTone();
  const reduce = useReducedMotion();
  const { art, eyesW, eyesH, restCy, centerX, w, h } = useOnboardingEyes();

  const eyeCy = useMotionValue(0);
  const eyeScale = useMotionValue(1);
  const eyeX = useMotionValue(0);

  const [ready, setReady] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const [showSmarter, setShowSmarter] = useState(reduce);
  const [showFaster, setShowFaster] = useState(reduce);
  const [landed, setLanded] = useState(reduce);

  // Park the eyes at rest (and short-circuit for reduced motion).
  useEffect(() => {
    eyeCy.set(restCy);
    setReady(true);
  }, [restCy, eyeCy]);

  useEffect(() => {
    if (reduce || !art) return;

    eyeCy.set(restCy);
    eyeScale.set(1);
    eyeX.set(0);

    const controls: ReturnType<typeof animate>[] = [];
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;
    const track = <T extends ReturnType<typeof animate>>(c: T): T => {
      controls.push(c);
      return c;
    };
    const wait = (ms: number) =>
      new Promise<void>((res) => {
        timeouts.push(setTimeout(res, ms));
      });
    const blink = async (hold = 120) => {
      setBlinking(true);
      await wait(hold);
      if (!cancelled) setBlinking(false);
    };

    // A subtle side-to-side dart (kept small — was too much before).
    const dash = Math.min(42, w * 0.026);

    const run = async () => {
      // Let the heading + team settle in (briefly).
      await wait(550);
      if (cancelled) return;

      // "The smarter I get" — the eyes swell up a bit to get smarter, then ease
      // back down.
      setShowSmarter(true);
      await wait(60);
      if (cancelled) return;
      await track(
        animate(eyeScale, 1.9, { duration: 0.4, ease: [0.34, 1.3, 0.64, 1] }),
      );
      if (cancelled) return;
      await blink(90);
      await track(animate(eyeScale, 1, { duration: 0.32, ease: "easeInOut" }));
      if (cancelled) return;
      await wait(160);
      if (cancelled) return;

      // "The faster..." — a quick, subtle side-to-side dart to show speed.
      setShowFaster(true);
      await wait(60);
      if (cancelled) return;
      await track(
        animate(eyeX, [0, dash, -dash, 0], {
          duration: 0.42,
          ease: "easeInOut",
          times: [0, 0.33, 0.66, 1],
        }),
      );
      if (cancelled) return;
      await wait(120);
      if (cancelled) return;
      setLanded(true);
    };
    void run();

    return () => {
      cancelled = true;
      controls.forEach((c) => c.stop());
      timeouts.forEach(clearTimeout);
    };
  }, [reduce, art, w, h, restCy, eyeCy, eyeScale, eyeX]);

  return (
    <div className="absolute inset-0 z-10 overflow-hidden" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      {/* The assistant's eyes, peeking from the bottom — they act out each line. */}
      {ready && art && (
        <MotionEyes
          art={art}
          eyesW={eyesW}
          eyesH={eyesH}
          centerX={centerX}
          eyeCy={eyeCy}
          eyeScale={eyeScale}
          eyeX={eyeX}
          blinking={blinking}
        />
      )}

      <div className="absolute left-1/2 top-[30%] z-10 flex w-full max-w-4xl -translate-x-1/2 flex-col items-center gap-8 px-6 text-center">
        {/* Drops down from the top with the team — teamwork carrying the line in. */}
        <motion.h1
          className="whitespace-nowrap text-[clamp(2.25rem,5.5vw,4.25rem)] leading-[1.1]"
          style={{ fontFamily: "var(--font-serif)", color: tone.fgDeep }}
          initial={reduce ? false : { opacity: 0, y: -Math.round(h * 0.26) }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : { type: "spring", stiffness: 130, damping: 17, delay: 0.1 }
          }
        >
          {TOGETHER_HEADING}
        </motion.h1>

        {/* Two benefits, each acted out by the eyes as it appears. */}
        <div className="flex flex-col gap-4">
          <motion.p
            className="text-[clamp(1.75rem,3.4vw,2.75rem)] leading-snug"
            style={{ fontFamily: "var(--font-serif)" }}
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={showSmarter ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
            transition={reduce ? { duration: 0 } : { duration: 0.3, ease: "easeOut" }}
          >
            {SMARTER_LINE}
          </motion.p>
          <motion.p
            className="text-[clamp(1.75rem,3.4vw,2.75rem)] leading-snug"
            style={{ fontFamily: "var(--font-serif)" }}
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={showFaster ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
            transition={reduce ? { duration: 0 } : { duration: 0.3, ease: "easeOut" }}
          >
            {FASTER_LINE}
          </motion.p>
        </div>

        {landed && (
          <motion.button
            type="button"
            onClick={onContinue}
            className="flex h-11 w-[234px] items-center justify-center gap-2 rounded-[10px] bg-black text-body-medium-default text-white transition-transform duration-150 active:scale-[0.97]"
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.4 }}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </motion.button>
        )}
      </div>
    </div>
  );
}
