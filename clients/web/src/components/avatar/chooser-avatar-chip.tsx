/**
 * Avatar for an assistant row in a chooser list: character traits, else the
 * uploaded image, else the caller's `fallback`. Traits outrank the image to
 * match `ChatAvatar`. The fallback also stands in while the lazily loaded
 * character components resolve, so the row never goes blank. Traits whose ids
 * are missing from the palette (legacy or hand-written sidecars) fall through
 * to the image, then the fallback.
 */

import type { ReactNode } from "react";

import { AvatarRenderer } from "@/components/avatar-renderer";
import { useTranslation } from "@/i18n";
import type { CharacterTraits } from "@/types/avatar";
import { canResolveDefinitions } from "@/utils/avatar-svg-compositor";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

export interface ChooserAvatarChipProps {
  traits: CharacterTraits | null;
  imageUrl: string | null;
  /** Pixel size. Defaults to 48, the chooser card icon slot. */
  size?: number;
  /** Rendered when there is no avatar, or while the character chunk loads. */
  fallback: ReactNode;
  className?: string;
  /** Hide from assistive tech when a sibling already names the row. */
  decorative?: boolean;
  /** Fires when `imageUrl` fails to load. */
  onImageError?: () => void;
}

export function ChooserAvatarChip({
  traits,
  imageUrl,
  size = 48,
  fallback,
  className,
  decorative = false,
  onImageError,
}: ChooserAvatarChipProps) {
  const { t } = useTranslation();
  const components = useBundledAvatarComponents();

  if (traits) {
    if (!components) {
      return fallback;
    }
    const renderable = canResolveDefinitions(
      components,
      traits.bodyShape,
      traits.eyeStyle,
      traits.color,
    );
    if (renderable) {
      const avatar = (
        <AvatarRenderer
          components={components}
          bodyShapeId={traits.bodyShape}
          eyeStyleId={traits.eyeStyle}
          colorId={traits.color}
          size={size}
          className={className}
        />
      );
      return decorative ? <span aria-hidden="true">{avatar}</span> : avatar;
    }
  }

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={decorative ? "" : t("chooserAvatarChip.alt")}
        width={size}
        height={size}
        className={`rounded-full object-cover ${className ?? ""}`.trim()}
        style={{ width: size, height: size, flexShrink: 0 }}
        onError={onImageError}
      />
    );
  }

  return fallback;
}
