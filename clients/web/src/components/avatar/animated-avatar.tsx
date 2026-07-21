import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

import { computeTransforms, resolveDefinitions } from "@/utils/avatar-svg-compositor";
import type { CharacterComponents, CharacterTraits, EyePathDefinition } from "@/types/avatar";

interface AnimatedAvatarProps {
  components: CharacterComponents;
  traits: CharacterTraits;
  size: number;
  isAssistantBusy?: boolean;
  /**
   * Continuous idle "breathing" scale pulse. On by default; pass `false` to
   * keep the avatar still while leaving blink/twitch (and streaming morph)
   * intact — e.g. the scattered onboarding edge characters.
   */
  breathe?: boolean;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// SVG path wobble — port of macOS EditablePath.wobbled()

interface PathPoint {
  x: number;
  y: number;
}

function parsePathNumbers(d: string): number[] {
  const nums: number[] = [];
  const re = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    nums.push(parseFloat(m[0]));
  }
  return nums;
}

function computeCentroid(d: string): PathPoint {
  const nums = parsePathNumbers(d);
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let i = 0; i < nums.length - 1; i += 2) {
    sx += nums[i]!;
    sy += nums[i + 1]!;
    count++;
  }
  return count > 0 ? { x: sx / count, y: sy / count } : { x: 0, y: 0 };
}

function wobblePath(d: string, seed: number, amount: number): string {
  const center = computeCentroid(d);
  const phase = seed * 1.1;

  return d.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi, (match, offset: number) => {
    const val = parseFloat(match);
    const prevText = d.slice(0, offset);
    const numsBefore = prevText.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi);
    const idx = numsBefore ? numsBefore.length : 0;
    const isX = idx % 2 === 0;

    const refVal = isX ? center.x : center.y;
    const otherNums = parsePathNumbers(d);
    const pairedIdx = isX ? idx + 1 : idx - 1;
    const pairedVal =
      pairedIdx >= 0 && pairedIdx < otherNums.length
        ? otherNums[pairedIdx]!
        : refVal;

    const px = isX ? val : pairedVal;
    const py = isX ? pairedVal : val;

    const angle = Math.atan2(py - center.y, px - center.x);
    const wobble =
      Math.sin(angle * 2.0 + phase) * 0.7 +
      Math.sin(angle * 3.0 - phase * 0.5) * 0.3;
    const scale = 1.0 + wobble * amount;

    const result = refVal + (val - refVal) * scale;
    return result.toFixed(3);
  });
}

function precomputeWobbledPaths(
  basePath: string,
  count: number,
  amount: number,
): string[] {
  const paths: string[] = [basePath];
  for (let i = 1; i < count; i++) {
    paths.push(wobblePath(basePath, i, amount));
  }
  return paths;
}

/**
 * Character avatar rendered as React SVG elements with idle animations:
 *   - Breathing: continuous 4s scale pulse (CSS keyframe)
 *   - Blink: random 3-7s eye scaleY squish, 20% double-blink
 *   - Twitch: random 8-15s body rotation wobble
 *
 * During streaming (`isAssistantBusy`):
 *   - Morph: body path cycles through 16 wobbled variants
 *   - Scale + rotation CSS animations
 *   - Blink + twitch paused
 *
 * All animations respect `prefers-reduced-motion`.
 */
export function AnimatedAvatar({
  components,
  traits,
  size,
  isAssistantBusy = false,
  breathe = true,
}: AnimatedAvatarProps) {
  const reduce = useReducedMotion();

  const { bodyShape, eyeStyle, color } = resolveDefinitions(
    components,
    traits.bodyShape,
    traits.eyeStyle,
    traits.color,
  );
  const { bodyTransform, eyeTransform } = computeTransforms(
    bodyShape,
    eyeStyle,
    components,
    size,
  );

  const eyeVB = eyeStyle.sourceViewBox;
  const bodyVB = bodyShape.viewBox;
  const bodyScaleFactor = Math.min(size / bodyVB.width, size / bodyVB.height);
  const bodyTx = (size - bodyVB.width * bodyScaleFactor) / 2;
  const bodyTy = (size - bodyVB.height * bodyScaleFactor) / 2;
  const remapScale = Math.min(
    bodyVB.width / eyeVB.width,
    bodyVB.height / eyeVB.height,
  );

  const override = components.faceCenterOverrides.find(
    (o) => o.bodyShape === bodyShape.id && o.eyeStyle === eyeStyle.id,
  );
  const faceCenter = override ? override.faceCenter : bodyShape.faceCenter;
  const remapTx = faceCenter.x - eyeStyle.eyeCenter.x * remapScale;
  const remapTy = faceCenter.y - eyeStyle.eyeCenter.y * remapScale;

  const eyeCenterOutputX =
    bodyScaleFactor * (remapTx + eyeStyle.eyeCenter.x * remapScale) + bodyTx;
  const eyeCenterOutputY =
    bodyScaleFactor * (remapTy + eyeStyle.eyeCenter.y * remapScale) + bodyTy;

  // Wobble variants are only used during streaming, and precomputing them is
  // O(n²) per path — doing it eagerly for every avatar (e.g. the 10 mounted on
  // each onboarding step) caused a noticeable jank on mount. Compute lazily,
  // only once an avatar actually streams.
  const morphPaths = useMemo(
    () =>
      isAssistantBusy
        ? precomputeWobbledPaths(bodyShape.svgPath, 16, 0.06)
        : [bodyShape.svgPath],
    [bodyShape.svgPath, isAssistantBusy],
  );

  const [isBlinking, setIsBlinking] = useState(false);
  const [twitchAngle, setTwitchAngle] = useState(0);
  const [morphIndex, setMorphIndex] = useState(0);

  const morphTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Force eyes open whenever blinking is disabled (reduced-motion or
    // streaming). A blink is a `setIsBlinking(true)` → 150ms → `false` pair;
    // if `isAssistantBusy` flips true mid-blink, this effect's cleanup cancels the
    // pending "un-blink" timeout, so without this reset `isBlinking` freezes
    // at `true` and the eyes stay squished (scaleY 0.1) until the component
    // remounts (page refresh / conversation switch). Mirrors the twitch
    // guard (`effectiveTwitchAngle = isAssistantBusy ? 0 : twitchAngle`).
    if (reduce || isAssistantBusy) {
      setIsBlinking(false);
      return;
    }
    let cancelled = false;

    function scheduleBlink() {
      const timer = setTimeout(() => {
        if (cancelled) return;
        setIsBlinking(true);
        setTimeout(() => {
          if (cancelled) return;
          setIsBlinking(false);
          if (Math.random() < 0.2) {
            setTimeout(() => {
              if (cancelled) return;
              setIsBlinking(true);
              setTimeout(() => {
                if (cancelled) return;
                setIsBlinking(false);
                scheduleBlink();
              }, 150);
            }, 200);
          } else {
            scheduleBlink();
          }
        }, 150);
      }, randomBetween(3000, 7000));

      return timer;
    }

    const timer = scheduleBlink();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reduce, isAssistantBusy]);

  useEffect(() => {
    // Reset the body angle when twitching is disabled so a twitch interrupted
    // mid-flight by streaming can't freeze the body rotated. (The render also
    // guards this via `effectiveTwitchAngle`, but resetting the state keeps it
    // correct after streaming ends without waiting for the next twitch cycle.)
    if (reduce || isAssistantBusy) {
      setTwitchAngle(0);
      return;
    }
    let cancelled = false;

    function scheduleTwitch() {
      const timer = setTimeout(() => {
        if (cancelled) return;
        const angle =
          (Math.random() < 0.5 ? -1 : 1) * randomBetween(1, 2);
        setTwitchAngle(angle);
        setTimeout(() => {
          if (cancelled) return;
          setTwitchAngle(0);
          scheduleTwitch();
        }, 200);
      }, randomBetween(8000, 15000));

      return timer;
    }

    const timer = scheduleTwitch();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reduce, isAssistantBusy]);

  // Morph path cycling (only during streaming)
  useEffect(() => {
    if (!isAssistantBusy || reduce) {
      setMorphIndex(0);
      return;
    }

    let idx = 0;
    morphTimerRef.current = setInterval(() => {
      idx = (idx + 1) % morphPaths.length;
      setMorphIndex(idx);
    }, 150);

    return () => {
      if (morphTimerRef.current) clearInterval(morphTimerRef.current);
      morphTimerRef.current = null;
    };
  }, [isAssistantBusy, reduce, morphPaths.length]);

  const bodyCenterX = size / 2;
  const bodyCenterY = size / 2;

  const breatheAnimation = reduce
    ? "none"
    : isAssistantBusy
      ? "avatar-morph-scale 2.4s ease-in-out infinite, avatar-morph-rotate 3s ease-in-out infinite"
      : breathe
        ? "avatar-breathe-kf 4s ease-in-out infinite"
        : "none";

  const effectiveTwitchAngle = isAssistantBusy ? 0 : twitchAngle;
  // Never squish the eyes while streaming — guards the one frame between
  // `isAssistantBusy` flipping true and the blink effect resetting `isBlinking`.
  const effectiveBlinking = isBlinking && !isAssistantBusy;
  const currentBodyPath = morphPaths[morphIndex] ?? bodyShape.svgPath;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        animation: breatheAnimation,
        transformOrigin: "center",
      }}
    >
      <g
        style={{
          transform: `rotate(${effectiveTwitchAngle}deg)`,
          transformOrigin: `${bodyCenterX}px ${bodyCenterY}px`,
          transition:
            effectiveTwitchAngle !== 0
              ? "transform 0.2s ease-in-out"
              : "transform 0.3s ease-out",
        }}
      >
        <path
          d={currentBodyPath}
          fill={color.hex}
          transform={bodyTransform}
          style={{
            transition: isAssistantBusy ? "d 0.3s ease-in-out" : "none",
          }}
        />
      </g>

      <g
        style={{
          transform: effectiveBlinking ? "scaleY(0.1)" : "scaleY(1)",
          transformOrigin: `${eyeCenterOutputX}px ${eyeCenterOutputY}px`,
          transition: "transform 0.15s ease-in-out",
        }}
      >
        {eyeStyle.paths.map((p: EyePathDefinition, i: number) => (
          <path
            key={i}
            d={p.svgPath}
            fill={p.color}
            transform={eyeTransform}
          />
        ))}
      </g>
    </svg>
  );
}
