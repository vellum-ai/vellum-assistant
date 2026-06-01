import { motion, useReducedMotion } from "motion/react";
import { useCallback, useMemo, useState, type CSSProperties } from "react";

import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import {
  getProgressBadgeVariant,
  type ProgressBadgeVariant,
} from "@/lib/feature-flags/progress-badge-flag";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { AnimatedAvatar } from "./animated-avatar";

export interface ChatAvatarProps {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  size?: number;
  className?: string;
  interactive?: boolean;
  isStreaming?: boolean;
  isProcessing?: boolean;
}

/** Tunable badge geometry. Sizes scale with avatar size for visual consistency. */
const BADGE_DOT_RATIO = 0.1; // each dot diameter / avatar size — 56px avatar → ~6px dot
const BADGE_GAP_RATIO = 0.05; // gap between dots / avatar size
const BADGE_RING_RATIO = 0.04; // ring thickness / avatar size

/**
 * Progress "thinking" indicator in the bottom-right corner of the avatar.
 * Two variants share the same pill geometry and surface-colored ring (which
 * separates the badge from the avatar so it reads cleanly against either a
 * character avatar or a custom image):
 *
 *   - `"dots"`: a pulsing three-dot pill. Reuses `ThreeDotIndicator` so the
 *     badge reads as the same typing affordance shown elsewhere in chat. A
 *     pill is wide enough to fit all three dots; a single round dot was too
 *     narrow to convey "thinking".
 *   - `"gradient"`: a glistening gradient pill that sweeps left to right,
 *     matching the "working" shimmer used elsewhere.
 */
function ProgressBadge({
  size,
  variant,
}: {
  size: number;
  variant: ProgressBadgeVariant;
}) {
  const dot = Math.max(3, Math.round(size * BADGE_DOT_RATIO));
  const gap = Math.max(2, Math.round(size * BADGE_GAP_RATIO));
  const ring = Math.max(1, Math.round(size * BADGE_RING_RATIO));
  return (
    <span
      aria-hidden="true"
      className="absolute flex items-center justify-center rounded-full"
      style={{
        bottom: 0,
        right: 0,
        padding: ring,
        backgroundColor: "var(--surface-base)",
      }}
    >
      {variant === "gradient" ? (
        <span
          className="progress-badge-shimmer block rounded-full"
          style={{ width: dot * 3 + gap * 2, height: dot }}
        />
      ) : (
        <ThreeDotIndicator dotSize={dot} gap={gap} />
      )}
    </span>
  );
}

/**
 * Displays the assistant's avatar in chat messages.
 *
 * Priority:
 * 1. Animated character avatar from saved traits
 * 2. Custom uploaded image
 * 3. Default animated character avatar from first component of each type
 * 4. Vellum "V" fallback
 *
 * Animation:
 *   - Mount plays an entrance spring (scale 0.6 → 1, opacity 0 → 1).
 *   - When `interactive`, click triggers a spring bounce.
 *   - `prefers-reduced-motion` short-circuits both.
 *   - When `isProcessing` and the `useProgressBadge` debug flag is on,
 *     the bottom-right `ProgressBadge` renders in its configured variant
 *     (pulsing dots or a gradient sweep). Default behavior (flag off)
 *     leaves the old transcript "thinking…" dots in charge.
 */
export function ChatAvatar({
  components,
  traits,
  customImageUrl,
  size = 28,
  className,
  interactive = false,
  isStreaming = false,
  isProcessing = false,
}: ChatAvatarProps) {
  const reduce = useReducedMotion();
  const [isPoking, setIsPoking] = useState(false);

  const triggerBounce = useCallback(() => {
    if (reduce) return;
    setIsPoking(true);
    window.setTimeout(() => setIsPoking(false), 360);
  }, [reduce]);

  const handleClick = interactive ? triggerBounce : undefined;

  const effectiveTraits = useMemo(() => {
    if (traits) return traits;
    if (!components) return null;
    const body = components.bodyShapes[0];
    const eyes = components.eyeStyles[0];
    const color = components.colors[0];
    if (!body || !eyes || !color) return null;
    return { bodyShape: body.id, eyeStyle: eyes.id, color: color.id };
  }, [traits, components]);

  const hasCharacter = !!components && !!effectiveTraits;
  const preferCharacter = hasCharacter && (!!traits || !customImageUrl);

  const wrapperStyle: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    cursor: interactive ? "pointer" : undefined,
    transformOrigin: "center",
    position: "relative",
  };

  const transition = reduce
    ? { duration: 0 }
    : { type: "spring" as const, visualDuration: 0.3, bounce: 0.5 };

  const initial = reduce
    ? { scale: 1, opacity: 1 }
    : { scale: 0.6, opacity: 0 };
  const animate = { scale: isPoking ? 1.15 : 1, opacity: 1 };

  const badgeVariant = isProcessing ? getProgressBadgeVariant() : null;

  if (preferCharacter) {
    return (
      <motion.div
        className={className}
        style={wrapperStyle}
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
      >
        <AnimatedAvatar
          components={components}
          traits={effectiveTraits}
          size={size}
          isStreaming={isStreaming}
        />
        {badgeVariant && <ProgressBadge size={size} variant={badgeVariant} />}
      </motion.div>
    );
  }

  if (customImageUrl) {
    return (
      <motion.div
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
        style={{
          cursor: interactive ? "pointer" : undefined,
          transformOrigin: "center",
          position: "relative",
          width: size,
          height: size,
          flexShrink: 0,
        }}
      >
        <img
          src={customImageUrl}
          alt="Assistant avatar"
          width={size}
          height={size}
          className={`rounded-full object-cover ${className ?? ""}`}
          style={{ width: size, height: size, flexShrink: 0 }}
        />
        {badgeVariant && <ProgressBadge size={size} variant={badgeVariant} />}
      </motion.div>
    );
  }

  return (
    <motion.div
      className={`flex items-center justify-center rounded-full bg-forest-600 text-white ${className ?? ""}`}
      style={{ ...wrapperStyle, fontSize: size * 0.45 }}
      onClick={handleClick}
      initial={initial}
      animate={animate}
      transition={transition}
    >
      V{badgeVariant && <ProgressBadge size={size} variant={badgeVariant} />}
    </motion.div>
  );
}
