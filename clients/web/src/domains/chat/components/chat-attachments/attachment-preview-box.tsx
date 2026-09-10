/**
 * The box an attachment draws itself in, wherever one is shown: a message
 * square in the transcript, a file tile in the Chat Info panel.
 *
 * An image fills the box edge to edge as a real `<img>`, so bytes the browser
 * cannot decode raise `onImageError` and the owner can fall back. A video
 * poster stays a CSS background instead: there is nothing to swap to when a
 * poster fails, so an `<img>` would surface the broken-image glyph. With
 * neither, the box draws the kind's glyph, or whatever `placeholder` the owner
 * shows while the bytes are still on their way.
 *
 * The box carries only its own layout; geometry, surface, and border come from
 * the caller's `className`.
 */

import type { ReactNode } from "react";

import {
  ATTACHMENT_ICON_BY_KIND,
  type AttachmentIconKind,
} from "@/domains/chat/components/chat-attachments/utils";
import { cn } from "@/utils/misc";

interface AttachmentPreviewBoxProps {
  /** Geometry, surface, and border classes for the box. */
  className?: string;
  /** Picks the fallback glyph. */
  kind: AttachmentIconKind;
  /** Drawn edge to edge when set. */
  imageUrl?: string | null;
  /** Video poster, painted behind the box. */
  posterUrl?: string | null;
  /** The browser could not decode `imageUrl`. */
  onImageError?: () => void;
  /** Sizing for the fallback glyph, which differs between surfaces. */
  glyphClassName?: string;
  /** Stands in for the glyph while the bytes are still being fetched. */
  placeholder?: ReactNode;
}

export function AttachmentPreviewBox({
  className,
  kind,
  imageUrl,
  posterUrl,
  onImageError,
  glyphClassName,
  placeholder,
}: AttachmentPreviewBoxProps) {
  const Icon = ATTACHMENT_ICON_BY_KIND[kind];

  let content: ReactNode;
  if (imageUrl) {
    content = (
      <img
        src={imageUrl}
        alt=""
        aria-hidden
        onError={onImageError}
        className="h-full w-full object-cover"
      />
    );
  } else if (placeholder) {
    content = placeholder;
  } else if (posterUrl) {
    content = null;
  } else {
    content = <Icon className={glyphClassName} />;
  }

  return (
    <div
      data-slot="attachment-preview-box"
      className={cn(
        "flex items-center justify-center overflow-hidden bg-cover bg-center text-[var(--content-secondary)]",
        className,
      )}
      style={
        posterUrl
          ? { backgroundImage: `url(${JSON.stringify(posterUrl)})` }
          : undefined
      }
    >
      {content}
    </div>
  );
}
