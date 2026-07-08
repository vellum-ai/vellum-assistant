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

import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@vellumai/design-library/components/button";

import { ONBOARDING_STEP_CONTENT } from "@/domains/onboarding/onboarding-step-layout";
import { OnboardingPeekingEyes } from "@/domains/onboarding/components/onboarding-peeking-eyes";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import {
  OnboardingStageSizeProvider,
  useElementSize,
} from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

interface IntroductionScreenProps {
  firstName: string;
  /** The name the user gave the assistant on the picker step (if any). */
  assistantName?: string;
  onContinue: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}

/** The body grow starts from the picker's centered size / position. */
const PICKER_SIZE = 200;
const PICKER_CENTER_VH = 40;

export function IntroductionScreen({
  firstName,
  assistantName,
  onContinue,
  onBack,
  onForward,
}: IntroductionScreenProps) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const reduce = useReducedMotion();
  // Measure this screen's container so the body grow and the peeking eyes share
  // one coordinate space (see use-onboarding-stage-size).
  const {
    ref: stageRef,
    size: { w, h },
  } = useElementSize();
  const tone = useOnboardingTone();

  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;

  const art = useMemo(() => {
    if (!components || !chosen) return null;
    const body = components.bodyShapes.find((b) => b.id === chosen.bodyShape);
    const color = components.colors.find((c) => c.id === chosen.color);
    if (!body || !color) return null;
    return { body, color: color.hex };
  }, [components, chosen]);

  const greeting = firstName.trim() ? `Hey, ${firstName.trim()}!` : "Hey!";
  const intro = assistantName?.trim()
    ? `I’m ${assistantName.trim()}, your new AI assistant`
    : "I’m your new AI assistant";

  if (!art) {
    return (
      <div
        data-theme="dark"
        className="h-full"
        style={{ backgroundColor: "var(--surface-base)" }}
      />
    );
  }

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
      ref={stageRef}
      data-theme="dark"
      className="relative h-full overflow-hidden"
      style={{ backgroundColor: "var(--surface-base)" }}
    ><OnboardingStageSizeProvider size={{ w, h }}>
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
        <OnboardingTopBar onBack={onBack} onNext={onForward} />
      </motion.div>

      {/* Greeting + Continue, grouped so the button sits just under the text. */}
      <div className={ONBOARDING_STEP_CONTENT}>
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
            style={{ color: tone.fgDeep }}
          >
            {greeting}
          </span>
          <span
            className="block text-[clamp(2.5rem,6vw,5rem)]"
            style={{ color: tone.fg }}
          >
            {intro}
          </span>
        </motion.h1>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.4, delay: 1.15 }}
        >
          <Button
            type="button"
            variant="primary"
            size="regular"
            rightIcon={<ArrowRight size={16} />}
            onClick={onContinue}
            className="h-11 w-[234px] text-base"
          >
            Continue
          </Button>
        </motion.div>
      </div>
      </OnboardingStageSizeProvider>
    </div>
  );
}
