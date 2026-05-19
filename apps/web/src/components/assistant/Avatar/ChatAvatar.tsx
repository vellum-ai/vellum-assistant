
import { motion, useReducedMotion } from "motion/react";
import { AppImage } from "@/adapters/app-image.js";
import { useCallback, useMemo, useState } from "react";

import type { CharacterComponents, CharacterTraits } from "@/lib/avatar/types.js";

import { AnimatedAvatar } from "@/components/assistant/Avatar/AnimatedAvatar.js";

export interface ChatAvatarProps {
  /** Character components fetched from the daemon. */
  components: CharacterComponents | null;
  /** The saved character traits, if any. */
  traits: CharacterTraits | null;
  /** URL to a custom uploaded avatar image, if any. */
  customImageUrl: string | null;
  /** Pixel size for the avatar. */
  size?: number;
  className?: string;
  /** When true, clicking the avatar triggers a spring bounce animation. */
  interactive?: boolean;
  /** When true, the character avatar plays the streaming morph animation. */
  isStreaming?: boolean;
}

/**
 * Displays the assistant's avatar in chat messages.
 *
 * Priority:
 * 1. Animated character avatar from saved traits (if components + explicit traits are available)
 * 2. Custom uploaded image (if customImageUrl is set)
 * 3. Default animated character avatar from first component of each type (if components loaded, no custom image)
 * 4. Vellum "V" fallback
 *
 * Animation:
 *   - Mount plays an entrance spring (scale 0.6 → 1, opacity 0 → 1).
 *   - When `interactive`, click triggers a spring bounce (1 → 1.15 → 1) using
 *     motion's SwiftUI-equivalent spring (`visualDuration: 0.3`, `bounce: 0.5`).
 *   - `prefers-reduced-motion` short-circuits both: entrance is instant and
 *     the bounce trigger is skipped.
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

  // Resolve effective traits: use saved traits when available, otherwise
  // fall back to the first component of each type so a character renders
  // even before traits are persisted (e.g. freshly hatched assistants
  // where the daemon hasn't synced character-traits.json yet).
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
  // Use the animated character when the user has deliberately saved traits.
  // When traits is null we only have default first-component fallbacks —
  // a custom uploaded image should win over those defaults.
  const preferCharacter = hasCharacter && (!!traits || !customImageUrl);

  const wrapperStyle: React.CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    cursor: interactive ? "pointer" : undefined,
    transformOrigin: "center",
  };

  // Reduced motion: instant entrance, no bounce. Otherwise: spring entrance
  // and spring bounce on click.
  const transition = reduce
    ? { duration: 0 }
    : { type: "spring" as const, visualDuration: 0.3, bounce: 0.5 };

  const initial = reduce ? { scale: 1, opacity: 1 } : { scale: 0.6, opacity: 0 };
  const animate = { scale: isPoking ? 1.15 : 1, opacity: 1 };

  // Animated character avatar — used when the user has saved character traits,
  // OR when no custom image is available and we fall back to default components.
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

  // Image fallback — daemon-rendered PNG or a user-uploaded photo.
  if (customImageUrl) {
    return (
      <motion.div
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
        style={{ cursor: interactive ? "pointer" : undefined, transformOrigin: "center" }}
      >
        <AppImage
          src={customImageUrl}
          alt="Assistant avatar"
          width={size}
          height={size}
          className={`rounded-full object-cover ${className ?? ""}`}
          style={{ width: size, height: size, flexShrink: 0 }}
          unoptimized
        />
      </motion.div>
    );
  }

  // Fallback: a simple "V" initial in a colored circle
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
