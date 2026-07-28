import {
  animate,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { type TourEyeArt } from "./tour-nav-flood";

/** How far a letter lifts at the wave's crest, as a fraction of the eyes'
 *  height. */
const LETTER_BUMP_FRACTION = 0.65;
/** How much the eyes poke up into the text band, as a fraction of their
 *  height — the reason the letters above need to move. */
const EYES_OVERLAP_FRACTION = 0.45;
/** Half-width of the wave, in eye-widths: how far from the eyes' center a
 *  letter starts rising. Wider = a broader, softer arch. */
const WAVE_REACH_EYES_WIDTHS = 0.8;
/** The slide's travel time across the line, and the beat before it. */
const SLIDE_DURATION_S = 1.1;
const SLIDE_DELAY_S = 0.05;
/** Expo-style launch curve: the eyes appear already at full speed and
 *  spend most of the leg decelerating. */
const LAUNCH_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
/** How far past the parking spot the eyes overshoot before bouncing back,
 *  in eye-widths. */
const OVERSHOOT_EYES_WIDTHS = 0.45;
/** Share of the slide spent reaching the overshoot point; the rest is the
 *  bounce back to the park. */
const OVERSHOOT_TIME_FRACTION = 0.72;
/** The settled eyes' double blink: beat before it, and its full length. */
const BLINK_DELAY_S = 0.3;
const BLINK_DURATION_S = 0.9;
/** The eyes arrive oversized and shrink to resting size as they cross the
 *  line — a deceleration you can see. */
const EYES_START_SCALE = 1.4;

interface LetterBox {
  left: number;
  right: number;
  bottom: number;
}

interface IntroEyesLineProps {
  /** The headline, split into words. */
  words: string[];
  eye: TourEyeArt;
  /** Rendered eye-pair width in px. */
  eyesWidth: number;
}

/**
 * The intro headline's eyes-under-the-text bit: once the line has typed,
 * a small pair of the avatar's eyes slides in from the left and travels
 * right beneath the words. Each LETTER rides a wave centered on the eyes —
 * rising as they approach, cresting directly above them, settling as they
 * pass — so the line ripples rather than hopping word by word. The eyes
 * park under "show" (or the middle word as a fallback), whose letters stay
 * arched over them. Letter positions are measured from the DOM after
 * render, so the choreography survives any font or viewport size.
 */
export function IntroEyesLine({ words, eye, eyesWidth }: IntroEyesLineProps) {
  const eyesHeight = eyesWidth * (eye.bbox.h / eye.bbox.w);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const letterRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [boxes, setBoxes] = useState<LetterBox[] | null>(null);

  /** Flat letter index where each word starts. */
  const wordOffsets: number[] = [];
  let letterCount = 0;
  for (const word of words) {
    wordOffsets.push(letterCount);
    letterCount += word.length;
  }

  const showIndex = words.findIndex((w) => /^show/i.test(w));
  const parkIndex = showIndex >= 0 ? showIndex : Math.floor(words.length / 2);

  /** The eyes' center X, in container coordinates — the single driver the
   *  eye sprite and every letter's lift derive from. */
  const eyesCenterX = useMotionValue(-eyesWidth);
  const eyesLeft = useTransform(eyesCenterX, (v) => v - eyesWidth / 2);

  /** Slide geometry, known once the letters are measured. */
  const parkFirst = boxes?.[wordOffsets[parkIndex]];
  const parkLast =
    boxes?.[wordOffsets[parkIndex] + words[parkIndex].length - 1];
  const startX = boxes && boxes.length > 0 ? boxes[0].left - eyesWidth : 0;
  const parkX =
    parkFirst && parkLast ? (parkFirst.left + parkLast.right) / 2 : 1;

  /** Size follows position: oversized at launch, resting size by the park
   *  (clamped through the overshoot, so the bounce doesn't re-inflate). */
  const eyesScale = useTransform(
    eyesCenterX,
    [startX, parkX],
    [EYES_START_SCALE, 1],
  );

  /** Set once the slide lands — cues the settled double blink. */
  const [parked, setParked] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current?.getBoundingClientRect();
    if (!container) {
      return;
    }
    setBoxes(
      letterRefs.current.slice(0, letterCount).map((el) => {
        const rect = el?.getBoundingClientRect();
        return rect
          ? {
              left: rect.left - container.left,
              right: rect.right - container.left,
              bottom: rect.bottom - container.top,
            }
          : { left: 0, right: 0, bottom: 0 };
      }),
    );
  }, [letterCount]);

  useEffect(() => {
    if (!boxes || boxes.length === 0) {
      return;
    }
    eyesCenterX.set(startX);
    // Launch at full speed the instant the eyes appear, decelerate across
    // the line, sail a little past the park, then drift back into it.
    const controls = animate(
      eyesCenterX,
      [startX, parkX + eyesWidth * OVERSHOOT_EYES_WIDTHS, parkX],
      {
        duration: SLIDE_DURATION_S,
        times: [0, OVERSHOOT_TIME_FRACTION, 1],
        ease: [LAUNCH_EASE, "easeInOut"],
        delay: SLIDE_DELAY_S,
      },
    );
    // The slide's length is fixed, so the blink cue is a plain timer — no
    // reliance on animation-completion callbacks.
    const parkTimer = window.setTimeout(
      () => setParked(true),
      (SLIDE_DELAY_S + SLIDE_DURATION_S) * 1000,
    );
    return () => {
      controls.stop();
      clearTimeout(parkTimer);
      setParked(false);
    };
  }, [boxes, startX, parkX, eyesWidth, eyesCenterX]);

  const lineBottom = boxes ? Math.max(...boxes.map((b) => b.bottom)) : 0;
  const waveReach = eyesWidth * WAVE_REACH_EYES_WIDTHS;

  return (
    <span ref={containerRef} className="relative inline-block">
      {words.map((word, wi) => (
        <span key={wi}>
          {/* Word wrapper keeps its letters from wrapping mid-word. */}
          <span className="inline-block whitespace-nowrap">
            {[...word].map((letter, li) => (
              <BumpingLetter
                key={li}
                letter={letter}
                box={boxes?.[wordOffsets[wi] + li] ?? null}
                eyesCenterX={eyesCenterX}
                bump={eyesHeight * LETTER_BUMP_FRACTION}
                reach={waveReach}
                spanRef={(el) => {
                  letterRefs.current[wordOffsets[wi] + li] = el;
                }}
              />
            ))}
          </span>
          {wi === words.length - 1 ? null : " "}
        </span>
      ))}
      {boxes ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute left-0"
          style={{
            x: eyesLeft,
            scale: eyesScale,
            top: lineBottom - eyesHeight * EYES_OVERLAP_FRACTION,
            width: eyesWidth,
            height: eyesHeight,
            // Anchor at the top so the oversized launch grows downward,
            // keeping the tuck into the text band constant.
            transformOrigin: "50% 0%",
          }}
        >
          {/* Blink wrapper: lid squash lives on its own layer so it
              composes with the slide's position-derived scale. */}
          <motion.span
            className="block h-full w-full"
            style={{ transformOrigin: "50% 55%" }}
            initial={false}
            animate={
              parked
                ? { scaleY: [1, 0.12, 1, 1, 0.12, 1] }
                : { scaleY: 1 }
            }
            transition={
              parked
                ? {
                    duration: BLINK_DURATION_S,
                    times: [0, 0.14, 0.3, 0.55, 0.7, 1],
                    ease: "easeInOut",
                    delay: BLINK_DELAY_S,
                  }
                : { duration: 0 }
            }
          >
            <svg
              viewBox={`${eye.bbox.x} ${eye.bbox.y} ${eye.bbox.w} ${eye.bbox.h}`}
              width="100%"
              height="100%"
              preserveAspectRatio="xMidYMid meet"
              style={{ overflow: "visible", display: "block" }}
            >
              {eye.paths.map((p, i) => (
                <path key={i} d={p.svgPath} fill={p.color} />
              ))}
            </svg>
          </motion.span>
        </motion.span>
      ) : null}
    </span>
  );
}

interface BumpingLetterProps {
  letter: string;
  /** Measured box, or null on the measuring first render. */
  box: LetterBox | null;
  eyesCenterX: MotionValue<number>;
  /** Lift in px at the wave's crest. */
  bump: number;
  /** Horizontal half-width of the wave in px. */
  reach: number;
  spanRef: (el: HTMLSpanElement | null) => void;
}

/** One letter of the headline, riding the wave: fully lifted when the
 *  eyes' center is directly beneath it, easing off linearly with distance
 *  (a spring rounds the motion). Letters over the parked eyes simply stay
 *  on the wave's crest. */
function BumpingLetter({
  letter,
  box,
  eyesCenterX,
  bump,
  reach,
  spanRef,
}: BumpingLetterProps) {
  const center = box ? (box.left + box.right) / 2 : 0;
  const y = useTransform(
    eyesCenterX,
    box ? [center - reach, center, center + reach] : [0, 1, 2],
    box ? [0, -bump, 0] : [0, 0, 0],
  );
  // Underdamped on purpose: each letter wobbles a touch as it lands, which
  // is most of the animation's life.
  const smoothY = useSpring(y, { stiffness: 700, damping: 17 });

  return (
    <motion.span ref={spanRef} className="inline-block" style={{ y: smoothY }}>
      {letter}
    </motion.span>
  );
}
