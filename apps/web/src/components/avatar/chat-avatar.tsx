import { motion, useReducedMotion } from "motion/react";
import { useCallback, useMemo, useState, type CSSProperties } from "react";

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
 */
export function ChatAvatar({
  components,
  traits,
  customImageUrl,
  size = 28,
  className,
  interactive = false,
  isStreaming = false,
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
      V
    </motion.div>
  );
}
