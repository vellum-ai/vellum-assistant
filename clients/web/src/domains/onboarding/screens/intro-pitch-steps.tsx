/**
 * Two short "what makes me different" statement steps that sit between the
 * Introduction and the talk-style step.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground only — they render over the shared `OnboardingTonedBackdrop`
 * (assistant color + bottom eyes), so they share the Introduction's look and
 * flow straight into the later toned steps.
 *
 *   - PitchDifferentStep  streams one line like an AI typing, then auto-advances
 *   - PitchTogetherStep   the "the more we work together" payoff + bullets
 */

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

/** Reveal `text` one character at a time; returns the visible prefix. */
function useTypewriter(
  text: string,
  { speed, enabled }: { speed: number; enabled: boolean },
): string {
  const [count, setCount] = useState(enabled ? 0 : text.length);

  useEffect(() => {
    if (!enabled) {
      setCount(text.length);
      return;
    }
    setCount(0);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text, speed, enabled]);

  return text.slice(0, count);
}

// The first half streams like an ordinary answering AI; the payoff shoots in to
// break that rhythm — the motion itself is the "I'm different".
const STREAM_LINE = "You’ve seen AI that answers.";
const PUNCH_LINE = "I’m different...";

/**
 * The setup line streams in (deliberately like every other AI), then "I'm
 * different..." shoots in to break the streaming rhythm. Holds a longer beat
 * once it lands before auto-advancing to the payoff.
 */
export function PitchDifferentStep({
  onDone,
  onBack,
  onForward,
}: {
  onDone: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  const tone = useOnboardingTone();
  const reduce = useReducedMotion();
  const shown = useTypewriter(STREAM_LINE, { speed: 55, enabled: !reduce });
  const streamDone = shown.length >= STREAM_LINE.length;
  const [punchLanded, setPunchLanded] = useState(false);

  // Hold once the payoff has landed, then advance. With reduced motion there's
  // no shoot-in to land, so start the hold as soon as the line is shown.
  useEffect(() => {
    if (reduce) {
      if (!streamDone) return;
      const t = setTimeout(onDone, 3600);
      return () => clearTimeout(t);
    }
    if (!punchLanded) return;
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [reduce, streamDone, punchLanded, onDone]);

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[32%] w-full max-w-3xl -translate-x-1/2 px-6 text-center">
        {/* Setup line — streamed, in a muted tone to read as the "ordinary" AI. */}
        <h1
          className="text-[clamp(2.25rem,5.5vw,4.5rem)] leading-[1.1]"
          style={{ fontFamily: "var(--font-serif)", color: tone.fgMuted }}
        >
          {shown}
          {/* Blinking caret while the setup line is still streaming in. */}
          {!streamDone && (
            <span className="ml-1 inline-block animate-pulse" aria-hidden="true">
              ▍
            </span>
          )}
        </h1>

        {/* Payoff — shoots in with a spring once the stream finishes. */}
        {streamDone && (
          <motion.h1
            className="mt-2 text-[clamp(2.25rem,5.5vw,4.5rem)] leading-[1.1]"
            style={{ fontFamily: "var(--font-serif)", color: tone.fg }}
            initial={reduce ? false : { opacity: 0, x: 140, scale: 0.85 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 320, damping: 17, delay: 0.2 }
            }
            onAnimationComplete={() => setPunchLanded(true)}
          >
            {PUNCH_LINE}
          </motion.h1>
        )}
      </div>
    </div>
  );
}

const TOGETHER_BULLETS = [
  "The smarter my instincts get",
  "The faster I can take things off your plate",
];

/**
 * The payoff: the relationship compounds. Title settles in, the bullets stagger
 * up, then a Continue affordance appears to carry on into the setup steps.
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

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[24%] flex w-full max-w-4xl -translate-x-1/2 flex-col items-center gap-10 px-6 text-center">
        <motion.h1
          className="whitespace-nowrap text-[clamp(2.25rem,5.5vw,4.25rem)] leading-[1.1]"
          style={{ fontFamily: "var(--font-serif)" }}
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.5 }}
        >
          The more we collaborate,
        </motion.h1>

        {/* Centered lines (matching the heading) so the list reads as
            intentional regardless of length — and wraps cleanly on mobile. */}
        <ul className="flex w-full flex-col gap-4 text-center">
          {TOGETHER_BULLETS.map((bullet, i) => (
            <motion.li
              key={bullet}
              className="text-[clamp(1.75rem,3.4vw,2.75rem)] leading-snug"
              style={{ fontFamily: "var(--font-serif)" }}
              initial={reduce ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reduce ? { duration: 0 } : { duration: 0.5, delay: 0.5 + i * 0.55 }
              }
            >
              <span aria-hidden="true" className="mr-3" style={{ color: tone.fgMuted }}>
                •
              </span>
              {bullet}
            </motion.li>
          ))}
        </ul>

        <motion.button
          type="button"
          onClick={onContinue}
          className="flex h-11 w-[234px] items-center justify-center gap-2 rounded-[10px] bg-black text-body-medium-default text-white transition-transform duration-150 active:scale-[0.97]"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : { duration: 0.4, delay: 0.6 + TOGETHER_BULLETS.length * 0.55 }
          }
        >
          Continue
          <ArrowRight className="h-4 w-4" />
        </motion.button>
      </div>
    </div>
  );
}
