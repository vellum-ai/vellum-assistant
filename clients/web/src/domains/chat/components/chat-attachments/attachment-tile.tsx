import { Loader2, X } from "lucide-react";
import type { MouseEventHandler } from "react";

import { useTranslation } from "@/i18n";

import { Button, cn } from "@vellumai/design-library";

/** The tile's corner, worn by the box and by the picture it clips. */
const TILE_RADIUS_CLASS = "rounded-[14px]";

interface AttachmentTileProps {
  id: string;
  filename: string;
  /** Decoded image URL. `null` while the upload is still in flight, which is
   *  what puts the tile on its spinner face. */
  previewUrl: string | null;
  onRemove: (id: string) => void;
  /** Opens the full-screen preview. */
  onPreview: () => void;
  /** Called when the browser cannot decode the preview. Lets the owner drop
   *  the tile for a chip, which still names the file. */
  onPreviewError: () => void;
  /** The composer's press guard. It rides both controls: a press anywhere on
   *  the tile would otherwise blur the textarea, collapsing the row before the
   *  click lands. */
  pressGuard?: MouseEventHandler<HTMLElement>;
}

/**
 * The mobile composer's attached image: a square thumbnail with a remove
 * control and no caption. The filename lives only in the tooltip and the
 * accessible names.
 */
export function AttachmentTile({
  id,
  filename,
  previewUrl,
  onRemove,
  onPreview,
  onPreviewError,
  pressGuard,
}: AttachmentTileProps) {
  const { t } = useTranslation("chat");

  return (
    <div
      data-slot="attachment-tile"
      title={filename}
      className={cn(
        "relative size-[100px] shrink-0 bg-[var(--surface-base)]",
        TILE_RADIUS_CLASS,
      )}
    >
      {previewUrl !== null ? (
        // The picture is the only thing the tile clips, so the remove control
        // keeps its full press target past the tile's corner.
        <button
          type="button"
          className={cn(
            "block size-full cursor-pointer overflow-hidden outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
            TILE_RADIUS_CLASS,
          )}
          aria-label={t("attachmentTile.preview", { filename })}
          onMouseDown={pressGuard}
          onClick={onPreview}
        >
          <img
            src={previewUrl}
            alt=""
            draggable={false}
            onError={onPreviewError}
            className="size-full object-cover"
          />
        </button>
      ) : (
        <div
          role="img"
          aria-label={t("attachmentTile.uploading", { filename })}
          className="flex size-full items-center justify-center text-[var(--content-tertiary)]"
        >
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}
      <Button
        variant="ghost"
        size="compact"
        iconOnly={<X />}
        expandOnMobile={false}
        // The `before:` pseudo-element widens the press target past the 24px
        // visual without moving it.
        className="absolute right-1.5 top-1.5 rounded-full bg-[var(--surface-lift)] [--vbtn-fg:var(--content-default)] before:absolute before:-inset-2 before:content-['']"
        iconOnlyGlyphClassName="size-3 [&_svg]:size-3"
        aria-label={t(
          previewUrl === null
            ? "attachmentTile.cancelUpload"
            : "attachmentTile.remove",
          { filename },
        )}
        onMouseDown={pressGuard}
        onClick={() => onRemove(id)}
      />
    </div>
  );
}
