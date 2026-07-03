/**
 * The pitch step — a single screen whose two lines carousel from the
 * "you've used other AI" framing to the "the more I help, the less you do"
 * payoff, with the assistant's avatar acting out each beat.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground only — it renders over the shared `OnboardingTonedBackdrop` and
 * choreographs the assistant's bottom eyes itself (so the route hides the
 * backdrop's resting pair on this step):
 *
 *   1. the eyes rise, wiping line 1 in bottom→top, then drop back, wiping
 *      line 2 in top→bottom;
 *   2. lines 1 + 2 carousel vertically together to "The more I help" / "The
 *      better I get" as a helper peeks from the top-left, then retracts;
 *   3. a third line, "The less you do", grows + wipes in as a small team peeks
 *      from the top-right, then retracts;
 *   4. a Continue button appears.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";

import { Button } from "@vellumai/design-library/components/button";
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

// Lines 1 + 2 carousel together from the setup framing to the first two payoff
// lines; line 3 ("The less you do") is then added in last.
const SETUP_LINE = "You’ve used AI that just answers questions";
const HELP_LINE = "The more I help";
const PUNCH_LINE = "I’m different";
const BETTER_LINE = "The better I get";
const LESS_LINE = "and the less you have to do";

// The little team that peeks in from the top-right on the second line, then
// retracts. (Kept in sync with TOP_TEAM in onboarding-toned-backdrop.tsx.)
const PITCH_TEAM = [
  { bodyShape: "blob", eyeStyle: "gentle" },
  { bodyShape: "urchin", eyeStyle: "curious" },
  { bodyShape: "star", eyeStyle: "goofy" },
];
const PITCH_TEAM_SIZE = 290;

/**
 * One carousel line: a window holding the first phrase above the second. The
 * first phrase wipes in (clip reveal); flipping `carouseled` rolls the window
 * up to the second phrase and collapses the window to that phrase's height (so
 * a 2-line setup line doesn't leave a gap once it carousels to a 1-line payoff).
 */
function CarouselLine({
  firstH,
  secondH,
  color,
  firstText,
  secondText,
  revealed,
  carouseled,
  revealFrom,
  revealDuration,
  reduce,
}: {
  firstH: number;
  secondH: number;
  color: string;
  firstText: string;
  secondText: string;
  revealed: boolean;
  carouseled: boolean;
  /** Which edge the first phrase wipes in from. */
  revealFrom: "bottom" | "top";
  revealDuration: number;
  reduce: boolean;
}) {
  const clipHidden =
    revealFrom === "bottom" ? "inset(100% 0 0 0)" : "inset(0 0 100% 0)";
  const clipShown = "inset(0% 0 0% 0)";
  // Wait for the measurer so the window opens at the right height (no grow-in).
  if (!firstH || !secondH) return null;
  return (
    <motion.div
      className="relative w-full overflow-hidden"
      initial={false}
      animate={{ height: carouseled ? secondH : firstH }}
      transition={reduce ? { duration: 0 } : { duration: 0.5, ease: "easeInOut" }}
    >
      <motion.div
        className="flex flex-col"
        style={{ color }}
        initial={false}
        animate={{ y: carouseled ? -firstH : 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.5, ease: "easeInOut" }}
      >
        <div className="flex items-center justify-center" style={{ height: firstH }}>
          <motion.span
            className="block"
            initial={false}
            animate={{ clipPath: revealed ? clipShown : clipHidden }}
            transition={reduce ? { duration: 0 } : { duration: revealDuration, ease: "easeOut" }}
          >
            {firstText}
          </motion.span>
        </div>
        <div className="flex items-center justify-center" style={{ height: secondH }}>
          <span className="block">{secondText}</span>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function PitchStep({
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
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;

  // Push the text/Continue block up so it doesn't crowd the eyes peeking from
  // the bottom — more so on short viewports, where the three lines + button and
  // the eyes are otherwise tight. The eye-wipe "above" target tracks this. The
  // short-screen offset stays modest so the Continue button sits close to the
  // text rather than stranded high above the eyes.
  const shortScreen = h > 0 && h <= 800;
  const contentTopFrac = shortScreen ? 0.17 : 0.22;
  const topClass = shortScreen ? "top-[17%]" : "top-[22%]";

  // The assistant's eyes rise to wipe the first lines in, then settle at rest.
  const eyeCy = useMotionValue(0);
  const eyeScale = useMotionValue(1);

  // A lone helper peeks from the top-left as line 1 carousels to "The more I help".
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

  // A small team peeks from the top-right as line 2 carousels to "The less you do".
  const teamColors = useMemo(() => {
    if (!components || !chosen) return [] as string[];
    return pickOverlayColors(chosen.color, components.colors.map((c) => c.id), 3);
  }, [components, chosen]);
  const peekScale = Math.max(0.42, Math.min(w / 1100, 1));
  const teamSize = Math.round(PITCH_TEAM_SIZE * peekScale);
  const teamHidden = -teamSize * 1.1; // fully above the top edge
  const teamPeek = -teamSize * 0.42; // ~42% cut off, peeking down
  const teamY = useMotionValue(-320);

  // Under reduced motion the setup lines show first (reveal true) but the
  // carousel starts unrolled (false) so the reduced-motion effect can swap to
  // the payoff after a beat — otherwise the setup copy is never seen.
  const [reveal1, setReveal1] = useState(!!reduce);
  const [reveal2, setReveal2] = useState(!!reduce);
  const [carousel1, setCarousel1] = useState(false);
  const [carousel2, setCarousel2] = useState(false);
  // The third line ("The less you do") is added in last.
  const [reveal3, setReveal3] = useState(false);
  const [ready, setReady] = useState(false);
  const [landed, setLanded] = useState(!!reduce);

  // Measure each line's slot height from a hidden copy so the carousel window
  // is tall enough for the taller of its two phrases (re-measured on resize).
  const blockW = Math.min(w, 768) - 48; // max-w-3xl minus px-6
  const m1aRef = useRef<HTMLSpanElement>(null);
  const m1bRef = useRef<HTMLSpanElement>(null);
  const m2aRef = useRef<HTMLSpanElement>(null);
  const m2bRef = useRef<HTMLSpanElement>(null);
  const m3Ref = useRef<HTMLSpanElement>(null);
  const [firstH1, setFirstH1] = useState(0);
  const [secondH1, setSecondH1] = useState(0);
  const [firstH2, setFirstH2] = useState(0);
  const [secondH2, setSecondH2] = useState(0);
  const [thirdH, setThirdH] = useState(0);
  useLayoutEffect(() => {
    if (m1aRef.current?.offsetHeight) setFirstH1(m1aRef.current.offsetHeight);
    if (m1bRef.current?.offsetHeight) setSecondH1(m1bRef.current.offsetHeight);
    if (m2aRef.current?.offsetHeight) setFirstH2(m2aRef.current.offsetHeight);
    if (m2bRef.current?.offsetHeight) setSecondH2(m2bRef.current.offsetHeight);
    if (m3Ref.current?.offsetHeight) setThirdH(m3Ref.current.offsetHeight);
  }, [blockW]);

  // Park the eyes at rest until the journey starts.
  useEffect(() => {
    eyeCy.set(restCy);
    setReady(true);
  }, [restCy, eyeCy]);

  // Reduced motion: reveal the first lines, then swap to the payoff; Continue
  // is offered throughout.
  useEffect(() => {
    if (!reduce) return;
    const t = setTimeout(() => {
      setCarousel1(true);
      setCarousel2(true);
      setReveal3(true);
    }, 1400);
    return () => clearTimeout(t);
  }, [reduce]);

  useEffect(() => {
    if (reduce || !art) return;

    eyeCy.set(restCy);
    eyeScale.set(1);
    helperY.set(helperHidden);
    teamY.set(teamHidden);
    setReveal1(false);
    setReveal2(false);
    setCarousel1(false);
    setCarousel2(false);

    const smallScale = 0.55; // up above the words
    const aboveCy = Math.max(eyesH * 0.5, h * contentTopFrac - 36); // clear above the title

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
      await wait(200);
      if (cancelled) return;

      // Eyes shoot up, wiping line 1 in bottom→top along the rise.
      setReveal1(true);
      await Promise.all([
        track(animate(eyeCy, aboveCy, { duration: 0.55, ease: "easeOut" })),
        track(animate(eyeScale, smallScale, { duration: 0.55, ease: "easeOut" })),
      ]);
      if (cancelled) return;

      // Eyes drop back to rest, wiping line 2 in top→bottom as they pass.
      setReveal2(true);
      await Promise.all([
        track(animate(eyeCy, restCy, { type: "spring", stiffness: 210, damping: 15 })),
        track(animate(eyeScale, 1, { duration: 0.45, ease: "easeOut" })),
      ]);
      if (cancelled) return;
      await wait(900);
      if (cancelled) return;

      // Carousel lines 1 + 2 together → "The more I help" / "The better I get"
      // as a helper peeks from the top-left.
      setCarousel1(true);
      setCarousel2(true);
      await track(
        animate(helperY, [helperHidden, helperPeek, helperPeek, helperHidden], {
          duration: 1.5,
          times: [0, 0.28, 0.62, 1],
          ease: "easeInOut",
        }),
      );
      if (cancelled) return;
      await wait(150);
      if (cancelled) return;

      // Add line 3 → "The less you do" as a team peeks from the top-right.
      setReveal3(true);
      const teamPeekAnim = track(
        animate(teamY, [teamHidden, teamPeek, teamPeek, teamHidden], {
          duration: 1.5,
          times: [0, 0.28, 0.62, 1],
          ease: "easeInOut",
        }),
      );
      await wait(700);
      if (cancelled) return;
      // Surface Continue while the team finishes peeking back out.
      setLanded(true);
      await teamPeekAnim;
    };
    void run();

    return () => {
      cancelled = true;
      controls.forEach((c) => c.stop());
      timeouts.forEach(clearTimeout);
    };
  }, [
    reduce,
    art,
    h,
    contentTopFrac,
    eyesH,
    restCy,
    eyeCy,
    eyeScale,
    helperY,
    helperHidden,
    helperPeek,
    teamY,
    teamHidden,
    teamPeek,
  ]);

  return (
    <div className="absolute inset-0 z-10 overflow-hidden" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      {/* Hidden measurer — sizes the carousel windows to the taller phrase. */}
      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute -left-[9999px] top-0 text-[clamp(2.25rem,5.5vw,4.5rem)] leading-[1.15]"
        style={{ width: blockW, fontFamily: "var(--font-serif)" }}
      >
        <span ref={m1aRef} className="block">{SETUP_LINE}</span>
        <span ref={m1bRef} className="block">{HELP_LINE}</span>
        <span ref={m2aRef} className="block">{PUNCH_LINE}</span>
        <span ref={m2bRef} className="block">{BETTER_LINE}</span>
        <span ref={m3Ref} className="block">{LESS_LINE}</span>
      </div>

      {/* The assistant's eyes — behind the text, lifting the words into view as
          they rise. */}
      {ready && art && (
        <MotionEyes
          art={art}
          eyesW={eyesW}
          eyesH={eyesH}
          centerX={centerX}
          eyeCy={eyeCy}
          eyeScale={eyeScale}
          blinking={false}
        />
      )}

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

      {/* The team that peeks down from the top-right on the second line. */}
      {!reduce && components && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-0 z-[1] flex items-start"
          style={{ right: -Math.round(teamSize * 0.12), y: teamY }}
        >
          {PITCH_TEAM.map((m, i) => (
            <div
              key={m.bodyShape}
              style={{
                width: teamSize,
                height: teamSize,
                marginLeft: i === 0 ? 0 : -teamSize * 0.34,
                zIndex: PITCH_TEAM.length - i,
              }}
            >
              <AnimatedAvatar
                components={components}
                traits={{
                  bodyShape: m.bodyShape,
                  eyeStyle: m.eyeStyle,
                  color: teamColors[i] ?? "teal",
                }}
                size={teamSize}
                breathe={false}
              />
            </div>
          ))}
        </motion.div>
      )}

      <div className={`${ONBOARDING_STEP_CONTENT.replace("top-[30%]", topClass)} max-w-3xl`}>
        <div
          className="flex w-full flex-col gap-3 text-[clamp(2.25rem,5.5vw,4.5rem)] leading-[1.15]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {/* Line 1 — the darker secondary tone; wipes in bottom→top. */}
          <CarouselLine
            firstH={firstH1}
            secondH={secondH1}
            color={tone.fgDeep}
            firstText={SETUP_LINE}
            secondText={HELP_LINE}
            revealed={reveal1}
            carouseled={carousel1}
            revealFrom="bottom"
            revealDuration={0.55}
            reduce={!!reduce}
          />
          {/* Line 2 — full-strength; wipes in top→bottom. */}
          <CarouselLine
            firstH={firstH2}
            secondH={secondH2}
            color={tone.fg}
            firstText={PUNCH_LINE}
            secondText={BETTER_LINE}
            revealed={reveal2}
            carouseled={carousel2}
            revealFrom="top"
            revealDuration={0.45}
            reduce={!!reduce}
          />
          {/* Line 3 — added in last: grows in (height 0→full) and wipes in. */}
          <motion.div
            className="relative w-full overflow-hidden"
            style={{ color: tone.fg }}
            initial={false}
            animate={{ height: reveal3 ? thirdH : 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.5, ease: "easeInOut" }}
          >
            {thirdH > 0 && (
              <div
                className="flex items-center justify-center"
                style={{ height: thirdH }}
              >
                <motion.span
                  className="block"
                  initial={false}
                  animate={{
                    clipPath: reveal3 ? "inset(0% 0 0% 0)" : "inset(100% 0 0 0)",
                  }}
                  transition={
                    reduce ? { duration: 0 } : { duration: 0.5, ease: "easeOut" }
                  }
                >
                  {LESS_LINE}
                </motion.span>
              </div>
            )}
          </motion.div>
        </div>

        {landed && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.4 }}
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
        )}
      </div>
    </div>
  );
}
