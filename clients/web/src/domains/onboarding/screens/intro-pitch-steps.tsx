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

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import {
  MotionEyes,
  useOnboardingEyes,
} from "@/domains/onboarding/components/onboarding-motion-eyes";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { pickOverlayColors } from "@/domains/onboarding/onboarding-avatar-colors";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { ONBOARDING_STEP_CONTENT } from "@/domains/onboarding/onboarding-step-layout";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

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

      <div className={`${ONBOARDING_STEP_CONTENT} max-w-3xl`}>
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
          {/* Payoff — the full-strength foreground. */}
          <motion.span
            className="block"
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

const HELP_LINE = "The more I help";
const LESS_LINE = "The less you do";

/**
 * The payoff: two benefits, each with its own beat —
 *   - "The more I help"  a helper peeks down from the top-left, then back
 *   - "The less you do"  the team drops in from the top-right (and stays)
 */
export function PitchTogetherStep({
  onContinue,
  onBack,
  onForward,
  onRevealTeam,
}: {
  onContinue: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
  /** Reveal the persistent top-right team (fires on the third line). */
  onRevealTeam: () => void;
}) {
  const tone = useOnboardingTone();
  const reduce = useReducedMotion();
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;
  const { w } = useOnboardingEyes();

  // A lone helper that peeks down from the top-left on the first line.
  const helperColor = useMemo(() => {
    if (!components || !chosen) return "orange";
    return (
      pickOverlayColors(chosen.color, components.colors.map((c) => c.id), 1)[0] ??
      "orange"
    );
  }, [components, chosen]);
  const helperSize = Math.min(220, Math.max(150, w * 0.16));
  const helperHidden = -helperSize; // fully above the top edge
  const helperPeek = -helperSize * 0.4; // ~40% cut off, peeking down

  const helperY = useMotionValue(-220);

  const [show1, setShow1] = useState(reduce);
  const [show2, setShow2] = useState(reduce);
  const [landed, setLanded] = useState(reduce);

  // Reduced motion: show the team straight away.
  useEffect(() => {
    if (reduce) onRevealTeam();
  }, [reduce, onRevealTeam]);

  useEffect(() => {
    if (reduce) return;

    helperY.set(helperHidden);

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

    const run = async () => {
      await wait(450);
      if (cancelled) return;

      // "The more I help" — a helper peeks down from the top-left, then retracts.
      setShow1(true);
      await track(
        animate(helperY, [helperHidden, helperPeek, helperPeek, helperHidden], {
          duration: 1.5,
          times: [0, 0.28, 0.62, 1],
          ease: "easeInOut",
        }),
      );
      if (cancelled) return;
      await wait(280);
      if (cancelled) return;

      // "The less you do" — the team drops in from the top-right.
      setShow2(true);
      onRevealTeam();
      await wait(700);
      if (cancelled) return;
      setLanded(true);
    };
    void run();

    return () => {
      cancelled = true;
      controls.forEach((c) => c.stop());
      timeouts.forEach(clearTimeout);
    };
  }, [reduce, helperY, helperHidden, helperPeek, onRevealTeam]);

  const lineClass = "text-[clamp(1.85rem,3.8vw,2.9rem)] leading-snug";
  const lineStyle = { fontFamily: "var(--font-serif)" } as const;
  const lineTransition = reduce
    ? { duration: 0 }
    : { duration: 0.3, ease: "easeOut" as const };

  return (
    <div className="absolute inset-0 z-10 overflow-hidden" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      {/* The helper that peeks down from the top-left on the first line. */}
      {!reduce && components && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute z-[1]"
          style={{
            left: Math.max(16, w * 0.05),
            top: 0,
            y: helperY,
            width: helperSize,
            height: helperSize,
          }}
        >
          <AnimatedAvatar
            components={components}
            traits={{ bodyShape: "blob", eyeStyle: "goofy", color: helperColor }}
            size={helperSize}
            breathe={false}
          />
        </motion.div>
      )}

      <div className={`${ONBOARDING_STEP_CONTENT} max-w-3xl`}>
        {/* Two benefits, each revealed with its own beat. */}
        <div className="flex flex-col gap-4">
          <motion.p
            className={lineClass}
            style={lineStyle}
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={show1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
            transition={lineTransition}
          >
            {HELP_LINE}
          </motion.p>
          <motion.p
            className={lineClass}
            style={lineStyle}
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={show2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
            transition={lineTransition}
          >
            {LESS_LINE}
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
