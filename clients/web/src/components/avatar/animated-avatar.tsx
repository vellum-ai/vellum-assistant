import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

import {
  computeTransforms,
  resolveDefinitions,
} from "@/utils/avatar-svg-compositor";
import type {
  CharacterComponents,
  CharacterTraits,
  EyePathDefinition,
} from "@/types/avatar";

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

function computeCentroid(nums: number[]): PathPoint {
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

function wobblePath(
  d: string,
  nums: number[],
  center: PathPoint,
  seed: number,
  amount: number,
): string {
  const phase = seed * 1.1;
  let idx = 0;

  return d.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi, () => {
    const currentIdx = idx;
    idx++;
    const val = nums[currentIdx]!;
    const isX = currentIdx % 2 === 0;

    const refVal = isX ? center.x : center.y;
    const pairedIdx = isX ? currentIdx + 1 : currentIdx - 1;
    const pairedVal =
      pairedIdx >= 0 && pairedIdx < nums.length ? nums[pairedIdx]! : refVal;

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
  const nums = parsePathNumbers(basePath);
  const center = computeCentroid(nums);
  const paths: string[] = [basePath];
  for (let i = 1; i < count; i++) {
    paths.push(wobblePath(basePath, nums, center, i, amount));
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

  // Wobble variants are only used during streaming. Compute them lazily so
  // idle avatars (including the set mounted during onboarding) do no path
  // transformation work.
  const morphPaths = useMemo(
    () =>
      isAssistantBusy
        ? precomputeWobbledPaths(bodyShape.svgPath, 16, 0.06)
        : [bodyShape.svgPath],
    [bodyShape.svgPath, isAssistantBusy],
  );

  const [isBlinking, setIsBlinking] = useState(false);
  const [twitchAngle, setTwitchAngle] = useState(0);

  const bodyPathRef = useRef<SVGPathElement | null>(null);

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
      const timer = setTimeout(
        () => {
          if (cancelled) {
            return;
          }
          setIsBlinking(true);
          setTimeout(() => {
            if (cancelled) {
              return;
            }
            setIsBlinking(false);
            if (Math.random() < 0.2) {
              setTimeout(() => {
                if (cancelled) {
                  return;
                }
                setIsBlinking(true);
                setTimeout(() => {
                  if (cancelled) {
                    return;
                  }
                  setIsBlinking(false);
                  scheduleBlink();
                }, 150);
              }, 200);
            } else {
              scheduleBlink();
            }
          }, 150);
        },
        randomBetween(3000, 7000),
      );

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
      const timer = setTimeout(
        () => {
          if (cancelled) {
            return;
          }
          const angle = (Math.random() < 0.5 ? -1 : 1) * randomBetween(1, 2);
          setTwitchAngle(angle);
          setTimeout(() => {
            if (cancelled) {
              return;
            }
            setTwitchAngle(0);
            scheduleTwitch();
          }, 200);
        },
        randomBetween(8000, 15000),
      );

      return timer;
    }

    const timer = scheduleTwitch();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reduce, isAssistantBusy]);

  // Morph path cycling (only during streaming).
  //
  // Written straight to the DOM rather than held in React state. The morph is
  // decoration — a 6.7Hz wobble on a body outline — but as state it put a
  // React update on the queue every 150ms, per visible busy avatar, for the
  // whole length of every streaming turn. React counts commits that finish
  // with an update already pending and throws `Maximum update depth exceeded`
  // once fifty-one land back to back, so purely visual work has no business in
  // the commit stream at all; this was the most frequently blamed frame in
  // that error family (LUM-2859). `d` stays out of the rendered props below,
  // so an unrelated re-render never clobbers the imperative value.
  useEffect(() => {
    const el = bodyPathRef.current;
    if (!el) {
      return;
    }
    const basePath = morphPaths[0] ?? bodyShape.svgPath;
    if (!isAssistantBusy || reduce || morphPaths.length <= 1) {
      el.setAttribute("d", basePath);
      return;
    }

    let idx = 0;
    const timer = setInterval(() => {
      idx = (idx + 1) % morphPaths.length;
      const next = morphPaths[idx];
      if (next) {
        el.setAttribute("d", next);
      }
    }, 150);

    return () => {
      clearInterval(timer);
      // A turn that ends mid-cycle would otherwise leave the body frozen on a
      // wobbled variant instead of settling back to its resting shape.
      el.setAttribute("d", basePath);
    };
  }, [isAssistantBusy, reduce, morphPaths, bodyShape.svgPath]);

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
  // Resting shape. The morph effect above drives `d` from here on, so this
  // value must stay stable across re-renders — React only patches attributes
  // whose props changed, which is what keeps the imperative writes intact.
  const baseBodyPath = morphPaths[0] ?? bodyShape.svgPath;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        animation: breatheAnimation,
        transformOrigin: "center",
        // The body fills the viewBox edge to edge, so the busy wobble (±6%) and
        // the idle twitch draw past it and would otherwise be clipped flat.
        overflow: "visible",
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
          ref={bodyPathRef}
          d={baseBodyPath}
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
          <path key={i} d={p.svgPath} fill={p.color} transform={eyeTransform} />
        ))}
      </g>
    </svg>
  );
}
