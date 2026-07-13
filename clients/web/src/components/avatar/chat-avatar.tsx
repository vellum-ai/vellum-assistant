import { motion, useReducedMotion } from "motion/react";
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { getSoundManager } from "@/lib/sounds/sound-manager";
import { AnimatedAvatar } from "./animated-avatar";

export interface ChatAvatarProps {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  size?: number;
  className?: string;
  interactive?: boolean;
  isAssistantBusy?: boolean;
  /**
   * Stamp `data-voice-origin` on the avatar's root so the live-voice room can
   * find this on-screen avatar and grow its entrance from here. Set on the
   * assistant avatar the user sees before starting voice (the empty-state
   * greeting, the latest-turn transcript avatar).
   */
  originAnchor?: boolean;
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
 *     just outside the avatar's edge while `isAssistantBusy` is on
 *     (character avatars already signal streaming via their morph animation).
 */
function ChatAvatarComponent({
  components,
  traits,
  customImageUrl,
  size = 28,
  className,
  interactive = false,
  isAssistantBusy = false,
  originAnchor = false,
}: ChatAvatarProps) {
  const reduce = useReducedMotion();
  const [isPoking, setIsPoking] = useState(false);
  // Spread onto whichever root renders, so the room can locate this avatar.
  const anchorProps = originAnchor ? { "data-voice-origin": "" } : {};

  const triggerBounce = useCallback(() => {
    // Sound is independent of motion preference, so it plays before the
    // reduced-motion short-circuit that skips the bounce animation.
    void getSoundManager().play("character_poke");
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

  if (preferCharacter) {
    return (
      <motion.div
        {...anchorProps}
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
          isAssistantBusy={isAssistantBusy}
        />
      </motion.div>
    );
  }

  if (customImageUrl) {
    return (
      <motion.div
        {...anchorProps}
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
        {isAssistantBusy && <AvatarStreamingRing size={size} />}
      </motion.div>
    );
  }

  return (
    <motion.div
      {...anchorProps}
      className={`flex items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--content-inset)] ${className ?? ""}`}
      style={{ ...wrapperStyle, fontSize: size * 0.45 }}
      onClick={handleClick}
      initial={initial}
      animate={animate}
      transition={transition}
    >
      V
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
