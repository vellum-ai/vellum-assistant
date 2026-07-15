/**
 * Full-bleed "stage" for the About Assistant personality page: paints the
 * assistant's avatar color edge-to-edge and peeks the assistant up from
 * the bottom edge — its eyes for character avatars, or the uploaded image
 * in a circle for custom-image avatars. Pass `entrance` to play the
 * onboarding grow-in, where the avatar drops from the stage's center into
 * its resting peek.
 *
 * Children render above the backdrop and receive the stage's measured box
 * and foreground tone through `AssistantStageContext`, so text and controls
 * can contrast-match the tinted background and reserve the peeking avatar's
 * height at the bottom.
 */

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { cn } from "@vellumai/design-library";

import { useElementSize, type StageSize } from "@/hooks/use-element-size";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { toneForBg, type AvatarTone } from "@/utils/avatar-tone";

import { AssistantPeekingEyes, EYES_VISIBLE_FRACTION } from "./assistant-peeking-eyes";

/**
 * Backdrop when there is no avatar color to paint — a custom-image or
 * empty avatar on the otherwise-tinted stage. Matches onboarding's dark
 * surface so the two surfaces read as one family.
 */
const DEFAULT_STAGE_BG = "#17191C";

/**
 * Custom-image avatars sit fully visible above the stage's bottom edge —
 * unlike the eye art, a photo cut off at the edge reads as a bug, not a
 * peek.
 */
const IMAGE_BOTTOM_MARGIN = 24;
/** Custom-image circle sizing against the stage's smaller dimension. */
const IMAGE_TARGET_FRACTION = 0.2;
const IMAGE_MIN_PX = 96;
const IMAGE_MAX_PX = 160;

export interface AssistantStageValue {
  stage: StageSize;
  tone: AvatarTone;
  /** Bottom padding (px) that keeps content clear of the peeking avatar. */
  bottomReserve: number;
}

const AssistantStageContext = createContext<AssistantStageValue | null>(null);

/** Stage box + tone for content rendered inside `AssistantStage`. */
export function useAssistantStage(): AssistantStageValue {
  const ctx = useContext(AssistantStageContext);
  if (!ctx) {
    throw new Error("useAssistantStage must be used inside <AssistantStage>");
  }
  return ctx;
}

/** Resolve the avatar color hex for a character avatar, if any. */
export function resolveAvatarHex(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): string | null {
  if (!components || !traits) {
    return null;
  }
  return components.colors.find((c) => c.id === traits.color)?.hex ?? null;
}

interface AssistantStageProps {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  /** Play the avatar's grow-in entrance (eyes/image drop from center). */
  entrance?: boolean;
  children: ReactNode;
  className?: string;
}

export function AssistantStage({
  components,
  traits,
  customImageUrl,
  entrance = false,
  children,
  className,
}: AssistantStageProps) {
  const { ref, size } = useElementSize();

  const bg = resolveAvatarHex(components, traits) ?? DEFAULT_STAGE_BG;
  const tone = toneForBg(bg);

  const showEyes = Boolean(components && traits);
  const showImage = !showEyes && Boolean(customImageUrl);

  const imageSize = Math.round(
    Math.min(
      IMAGE_MAX_PX,
      Math.max(IMAGE_MIN_PX, Math.min(size.w, size.h) * IMAGE_TARGET_FRACTION),
    ),
  );
  const imageRestTop = size.h - imageSize - IMAGE_BOTTOM_MARGIN;
  const bottomReserve = showEyes
    ? Math.round(EYES_VISIBLE_FRACTION * Math.min(size.w, size.h)) + 16
    : showImage
      ? imageSize + IMAGE_BOTTOM_MARGIN + 16
      : 24;

  return (
    <div
      ref={ref}
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--border-base)]",
        className,
      )}
      style={{ backgroundColor: bg, color: tone.fg }}
    >
      {showEyes && components && traits && (
        <AssistantPeekingEyes
          components={components}
          traits={traits}
          stage={size}
          entrance={entrance}
        />
      )}
      {/* Custom images render fully static — the entrance drop-in is a
          character move; a photo just sits in place. */}
      {showImage && customImageUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-[2] overflow-hidden rounded-full ring-4 ring-white/25"
          style={{
            left: (size.w - imageSize) / 2,
            top: imageRestTop,
            width: imageSize,
            height: imageSize,
          }}
        >
          <img
            src={customImageUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        </div>
      )}

      <AssistantStageContext.Provider value={{ stage: size, tone, bottomReserve }}>
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </AssistantStageContext.Provider>
    </div>
  );
}
