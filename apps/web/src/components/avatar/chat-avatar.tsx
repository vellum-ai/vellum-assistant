import { motion, useReducedMotion } from "motion/react";
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";

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
 * `"dots"` progress affordance: a pulsing three-dot pill pinned to the
 * bottom-right corner of the avatar. Reuses `ThreeDotIndicator` so the badge
 * reads as the same typing affordance shown elsewhere in chat (a pill is wide
 * enough to fit all three dots; a single round dot was too narrow to convey
 * "thinking"). The surface-colored ring separates the badge from the avatar so
 * it reads cleanly against either a character avatar or a custom image.
 */
function ProgressDotsBadge({ size }: { size: number }) {
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
      <ThreeDotIndicator dotSize={dot} gap={gap} />
    </span>
  );
}

/**
 * `"gradient"` progress affordance: a glistening highlight band that sweeps
 * across the whole avatar (clipped to its circular frame) as a loading state,
 * echoing the "working" shimmer used elsewhere. Unlike the dots variant this
 * is an overlay over the entire avatar rather than a corner badge, so there is
 * no bottom-right indicator. The sweep and reduced-motion fallback live in CSS
 * (`.avatar-glisten`).
 */
function AvatarGlisten() {
  return (
    <span
      aria-hidden="true"
      className="avatar-glisten pointer-events-none absolute inset-0 overflow-hidden rounded-full"
    />
  );
}

/** Ring geometry. Thickness is a fixed 1px hairline; gap scales with size. */
const RING_THICKNESS = 1; // border thickness in px
const RING_GAP_RATIO = 0.04; // gap between avatar edge and ring inner edge / size

/**
 * Spinning semicircular ring traced just outside the avatar's circular edge,
 * shown while the assistant is streaming/loading. Only used for custom
 * uploaded-image avatars — character avatars already signal streaming through
 * their morph animation. The arc + rotation live in CSS (`.avatar-streaming-ring`);
 * thickness/inset are inline so the ring scales with `size`. It sits in a gap
 * outside the image (negative inset) so it reads as a ring around the avatar
 * rather than covering the picture.
 */
function AvatarStreamingRing({ size }: { size: number }) {
  const thickness = RING_THICKNESS;
  const gap = Math.max(1, Math.round(size * RING_GAP_RATIO));
  const inset = -(thickness + gap);
  return (
    <span
      aria-hidden="true"
      className="avatar-streaming-ring pointer-events-none absolute"
      style={{
        top: inset,
        right: inset,
        bottom: inset,
        left: inset,
        borderWidth: thickness,
        boxSizing: "border-box",
      }}
    />
  );
}

/** Render the active progress affordance for the configured badge variant. */
function ProgressOverlay({
  size,
  variant,
}: {
  size: number;
  variant: ProgressBadgeVariant;
}) {
  return variant === "gradient" ? (
    <AvatarGlisten />
  ) : (
    <ProgressDotsBadge size={size} />
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
 *   - For custom uploaded-image avatars, a spinning semicircular ring traces
 *     just outside the avatar's edge while `isStreaming`/`isProcessing` is on
 *     (character avatars already signal streaming via their morph animation).
 *   - When `isProcessing` and the `useProgressBadge` debug flag is on, the
 *     configured progress affordance renders: the `"dots"` variant shows a
 *     bottom-right three-dot badge, while the `"gradient"` variant glistens a
 *     sweep across the whole avatar (no corner badge). Default behavior (flag
 *     off) leaves the old transcript "thinking…" dots in charge.
 */
function ChatAvatarComponent({
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
        {badgeVariant && <ProgressOverlay size={size} variant={badgeVariant} />}
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
        {(isStreaming || isProcessing) && <AvatarStreamingRing size={size} />}
        {badgeVariant && <ProgressOverlay size={size} variant={badgeVariant} />}
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
      V{badgeVariant && <ProgressOverlay size={size} variant={badgeVariant} />}
    </motion.div>
  );
}

/**
 * Memoized so the avatar subtree only re-renders when its own props change
 * (components/traits/image, size, the streaming/processing flags) rather than
 * on every parent transcript re-render. `Transcript` is a `forwardRef` (not
 * memoized) and re-renders frequently during streaming, while the avatar runs
 * per-frame animation work — so skipping unrelated re-renders matters. All
 * props are primitives or stable references (avatar data is React-Query-cached
 * with `staleTime: Infinity`), so the default shallow comparison is correct.
 */
export const ChatAvatar = memo(ChatAvatarComponent);
