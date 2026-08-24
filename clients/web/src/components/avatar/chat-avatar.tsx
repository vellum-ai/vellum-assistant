import { motion, useReducedMotion } from "motion/react";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
} from "react";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { useTranslation } from "@/i18n";
import { getSoundManager } from "@/lib/sounds/sound-manager";
import { resolveEffectiveTraits } from "@/utils/avatar-render";
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
 *   - `isAssistantBusy` only affects character avatars, which signal streaming
 *     via their morph animation. Custom uploaded images stay static — the
 *     transcript's thinking indicator carries that state instead.
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
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const [isPoking, setIsPoking] = useState(false);
  // Spread onto whichever root renders, so the room can locate this avatar.
  const anchorProps = originAnchor ? { "data-voice-origin": "" } : {};

  const triggerBounce = useCallback(() => {
    // Sound is independent of motion preference, so it plays before the
    // reduced-motion short-circuit that skips the bounce animation.
    void getSoundManager().play("character_poke");
    if (reduce) {
      return;
    }
    setIsPoking(true);
    window.setTimeout(() => setIsPoking(false), 360);
  }, [reduce]);

  const handleClick = interactive ? triggerBounce : undefined;

  // Shared with every off-screen surface that draws this assistant, so the
  // default character here is the one the widgets and icons draw too.
  const effectiveTraits = useMemo(
    () => resolveEffectiveTraits(components, traits),
    [traits, components],
  );

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
          alt={t("chatAvatar.alt")}
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
      {...anchorProps}
      className={`flex items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--content-inset)] ${className ?? ""}`}
      style={{ ...wrapperStyle, fontSize: size * 0.45 }}
      onClick={handleClick}
      initial={initial}
      animate={animate}
      transition={transition}
    >
      {t("chatAvatar.fallbackLetter")}
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
