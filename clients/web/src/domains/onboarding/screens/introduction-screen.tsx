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
import { Button } from "@vellumai/design-library/components/button";

import { useTranslation } from "@/i18n";
import {
  ONBOARDING_DARK_SURFACE,
  ONBOARDING_STEP_CONTENT,
} from "@/domains/onboarding/onboarding-step-layout";
import { OnboardingPeekingEyes } from "@/domains/onboarding/components/onboarding-peeking-eyes";
import { OnboardingStage } from "@/domains/onboarding/components/onboarding-stage";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingStageSize } from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { cssTransitionFor } from "@/stores/page-surface-store";
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

interface IntroductionArt {
  body: { viewBox: { width: number; height: number }; svgPath: string };
  color: string;
}

/**
 * The chosen avatar's body, growing from the picker's size to cover the stage.
 *
 * Reads the stage box rather than taking it as a prop so it lands in the same
 * coordinate space as the peeking eyes and the greeting beside it.
 */
function IntroductionBodyGrow({
  art,
  reduce,
}: {
  art: IntroductionArt;
  reduce: boolean;
}) {
  const { w, h } = useOnboardingStageSize();
  const coverSize = 1.25 * Math.max(w, h);
  const coverH = (coverSize * art.body.viewBox.height) / art.body.viewBox.width;
  const bodyLeft = (w - coverSize) / 2;
  const bodyTop = (h - coverH) / 2;
  const bodyStartScale = PICKER_SIZE / coverSize;
  // Start near the picker's centre.
  const bodyStartY = (PICKER_CENTER_VH / 100 - 0.5) * h;

  return (
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
  );
}

/**
 * The tint layer's fade-in. Stated once for the layer itself and derived for
 * the safe-area strips the app shell paints, so the two cannot drift apart.
 * See `page-surface-store`.
 */
const TINT_FADE = { duration: 0.6, delay: 0.35 } as const;
const TINT_FADE_CSS = cssTransitionFor(TINT_FADE);

export function IntroductionScreen({
  firstName,
  assistantName,
  onContinue,
  onBack,
  onForward,
}: IntroductionScreenProps) {
  const { t } = useTranslation("onboarding");
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const reduce = useReducedMotion();
  const tone = useOnboardingTone();

  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;

  const art = useMemo(() => {
    if (!components || !chosen) {
      return null;
    }
    const body = components.bodyShapes.find((b) => b.id === chosen.bodyShape);
    const color = components.colors.find((c) => c.id === chosen.color);
    if (!body || !color) {
      return null;
    }
    return { body, color: color.hex };
  }, [components, chosen]);

  // The stage paints the picker's dark surface at once and fades the tint in
  // over it, so the strips have to start dark and follow rather than open on
  // the tint. Two things make that finicky. Arriving from the pitch step by
  // Back, the backdrop has already published this same hex, so publishing the
  // tint on mount is no color change at all and nothing transitions. And a
  // transition only starts if the dark value went through a style change event
  // first, which a passive effect does not guarantee: React schedules those on
  // a macrotask that usually beats the browser's next rendering opportunity, so
  // both writes would land in one style recalculation and coalesce back into
  // tint-to-tint.
  //
  // Hence the dark surface in the mount commit and the tint two frames later:
  // the first rAF still runs before this frame's style and paint, so the second
  // is the earliest callback that the dark value is guaranteed to have been
  // painted before. Reduced motion has no fade to follow and takes the tint at
  // once.
  //
  // The color layer below waits on this same flip, so its delay and the strips'
  // start together rather than the canvas leading them by the two frames.
  const [tintPublished, setTintPublished] = useState(false);
  useEffect(() => {
    if (!art || reduce) {
      return;
    }
    let painted = 0;
    const committed = requestAnimationFrame(() => {
      painted = requestAnimationFrame(() => setTintPublished(true));
    });
    return () => {
      cancelAnimationFrame(committed);
      cancelAnimationFrame(painted);
    };
  }, [art, reduce]);
  const stripTinted = Boolean(reduce) || tintPublished;

  const trimmedFirstName = firstName.trim();
  const trimmedAssistantName = assistantName?.trim() ?? "";
  const greeting = trimmedFirstName
    ? t("introductionScreen.greetingNamed", { name: trimmedFirstName })
    : t("introductionScreen.greeting");
  const intro = trimmedAssistantName
    ? t("introductionScreen.introNamed", { name: trimmedAssistantName })
    : t("introductionScreen.intro");

  if (!art) {
    // The bundled avatar art is a dynamic import that can be slow on a restored
    // journey and can fail outright, in which case this is what the user sits
    // on. It goes through the stage rather than a bare div so the strips get
    // the dark surface too: the stage is what publishes it, and the same stage
    // instance carries on into the tinted render below once the art lands.
    return <OnboardingStage className="bg-[var(--surface-base)]" />;
  }

  return (
    // Starts on the picker's dark surface; the color layer below fades in.
    <OnboardingStage
      className="bg-[var(--surface-base)]"
      surface={stripTinted ? art.color : ONBOARDING_DARK_SURFACE}
      // The strips fade on the color layer's own timing rather than jumping to
      // the tint while the stage is still dark.
      surfaceTransition={tintPublished ? TINT_FADE_CSS : undefined}
    >
      {/* The avatar color fills in so coverage is end-to-end even where the
          body shape has gaps/spikes. Held at zero until the strips have their
          dark starting color on screen, so the two fades share a start. */}
      <motion.div
        className="absolute inset-0 z-0"
        style={{ backgroundColor: art.color }}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: stripTinted ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : TINT_FADE}
      />

      {/* Body: grows from the picker size to cover the screen. */}
      <IntroductionBodyGrow art={art} reduce={reduce === true} />

      {/* Eyes peek up from the bottom, growing in alongside the body. */}
      <OnboardingPeekingEyes entrance />

      {/* Progress + back, fading in after the grow. */}
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
          className="text-center leading-[1.15] max-md:leading-[1.25]"
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
            {t("actions.continue")}
          </Button>
        </motion.div>
      </div>
    </OnboardingStage>
  );
}
