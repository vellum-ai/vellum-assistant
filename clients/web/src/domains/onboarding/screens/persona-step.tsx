/**
 * "Who do you want me to be?" — the free-text persona step that follows the
 * "Create my personality" sliders.
 *
 * SPIKE — research-onboarding flow (behind the personality-onboarding flag).
 *
 * A single broad question with a rotating showcase of example characters — each
 * a short archetype paired with its own mini avatar that swaps in as the
 * showcase cycles — over a free-text field. Below the field, a rotating example
 * input the user can tap to fill it in. Foreground content only; the shared
 * toned backdrop (avatar color + bottom eyes) sits behind, so this reads as the
 * same "eyes" world as the surrounding steps.
 *
 * The typed answer rides the same path as the slider values: the route forwards
 * it to `applyPersonality`, which weaves it into the system-message that
 * rewrites the assistant's identity files. A blank answer is fine — the sliders
 * still apply.
 */

import { useEffect, useState, type KeyboardEvent } from "react";
import { ArrowRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import {
  preloadBundledAvatarComponents,
  useBundledAvatarComponents,
} from "@/utils/use-bundled-avatar-components";
import type { CharacterTraits } from "@/types/avatar";

// Warm the bundled-avatar chunk as this lazy step's module loads.
preloadBundledAvatarComponents();

interface PersonaStepProps {
  /** Free-text character the assistant should embody, owned by the route. */
  persona: string;
  /** Report the persona text as the user edits it. */
  onPersonaChange: (next: string) => void;
  /**
   * Once the user has continued, the personality prompt has already been sent
   * to the assistant — lock the field so a step-back can't silently diverge.
   */
  locked: boolean;
  onContinue: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}

/**
 * Example characters cycled through the showcase + placeholder — spicy to
 * deadpan — to convey the range without prescribing an answer. Each pairs a
 * short archetype (shown beside its avatar) with the full phrase used as the
 * tappable example and the placeholder, plus a visually distinct avatar.
 */
interface PersonaExample {
  archetype: string;
  phrase: string;
  avatar: CharacterTraits;
}

const PERSONA_EXAMPLES: PersonaExample[] = [
  {
    archetype: "Sassy goth",
    phrase: "a sassy goth who calls me out",
    avatar: { bodyShape: "urchin", eyeStyle: "grumpy", color: "purple" },
  },
  {
    archetype: "Deadpan butler",
    phrase: "a deadpan butler quietly judging me",
    avatar: { bodyShape: "cloud", eyeStyle: "dazed", color: "green" },
  },
  {
    archetype: "Honest best friend",
    phrase: "a brutally honest best friend",
    avatar: { bodyShape: "blob", eyeStyle: "goofy", color: "pink" },
  },
  {
    archetype: "Noir detective",
    phrase: "a noir detective on the case",
    avatar: { bodyShape: "ninja", eyeStyle: "curious", color: "orange" },
  },
  {
    archetype: "Zen mentor",
    phrase: "a calm zen mentor who grounds me",
    avatar: { bodyShape: "sprout", eyeStyle: "bashful", color: "teal" },
  },
  {
    archetype: "Hype coach",
    phrase: "an over-the-top hype coach",
    avatar: { bodyShape: "star", eyeStyle: "goofy", color: "yellow" },
  },
];

/** Cadence for the showcase / example rotation. */
const ROTATE_INTERVAL_MS = 3000;

/** Mini-avatar size in the rotating showcase. */
const SHOWCASE_AVATAR = 52;

export function PersonaStep({
  persona,
  onPersonaChange,
  locked,
  onContinue,
  onBack,
  onForward,
}: PersonaStepProps) {
  const tone = useOnboardingTone();
  const components = useBundledAvatarComponents();
  const reduce = useReducedMotion();

  const [index, setIndex] = useState(0);
  // Rotate while the field is empty and editable — a typed answer (or a locked
  // step) freezes the showcase so it isn't distracting.
  const paused = locked || persona.trim().length > 0;
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      setIndex((i) => (i + 1) % PERSONA_EXAMPLES.length);
    }, ROTATE_INTERVAL_MS);
    return () => clearInterval(t);
  }, [paused]);

  const current = PERSONA_EXAMPLES[index] ?? PERSONA_EXAMPLES[0]!;

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !locked) {
      e.preventDefault();
      onContinue();
    }
  }

  return (
    <div
      className="absolute inset-0 z-10 overflow-hidden"
      style={{ color: tone.fg }}
    >
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-1/2 flex w-full max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-9 px-6">
        <h1
          className="text-center text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Who do you want me to be?
        </h1>

        {/* Rotating showcase: a mini avatar + its archetype, swapped as a unit so
            the block re-centers cleanly as the label width changes. */}
        <div className="flex h-[56px] items-center justify-center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={current.archetype}
              className="flex items-center gap-3"
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -12 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            >
              <div
                className="shrink-0"
                style={{ width: SHOWCASE_AVATAR, height: SHOWCASE_AVATAR }}
              >
                {components && (
                  <AnimatedAvatar
                    components={components}
                    traits={current.avatar}
                    size={SHOWCASE_AVATAR}
                  />
                )}
              </div>
              <span className="text-[20px]" style={{ color: tone.fg }}>
                {current.archetype}
              </span>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex w-full flex-col items-center gap-3">
          <input
            id="persona-input"
            type="text"
            value={persona}
            onChange={(e) => onPersonaChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={locked}
            autoComplete="off"
            placeholder={paused ? "Describe your own…" : current.phrase}
            aria-label="Who do you want me to be?"
            className="w-full max-w-md rounded-2xl border bg-transparent px-4 py-3 text-center text-[16px] outline-none transition-colors duration-150 placeholder:text-current placeholder:opacity-50 focus:border-current disabled:cursor-not-allowed disabled:opacity-70"
            style={{ color: tone.fg, borderColor: tone.fgMuted }}
          />

          {/* Rotating, tappable example input — fills the field on click. Height
              is reserved so the layout doesn't jump when it's hidden. */}
          <div className="flex h-6 items-center justify-center">
            <AnimatePresence mode="wait" initial={false}>
              {!paused && (
                <motion.button
                  key={current.phrase}
                  type="button"
                  onClick={() => onPersonaChange(current.phrase)}
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                  className="cursor-pointer text-[14px] underline-offset-2 transition-opacity hover:opacity-100 hover:underline"
                  style={{ color: tone.fgMuted }}
                >
                  Try “{current.phrase}”
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>

        <button
          type="button"
          onClick={onContinue}
          className="mt-2 flex h-11 w-[234px] cursor-pointer items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition-transform duration-150 active:scale-[0.97]"
          style={{
            backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
            color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
          }}
        >
          {persona.trim() ? "Continue" : "Skip for now"}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
