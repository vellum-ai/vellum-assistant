import { Loader2, X } from "lucide-react";
import type { MouseEventHandler } from "react";

import { useTranslation } from "@/i18n";

import { Button } from "@vellumai/design-library";

/**
 * The remove control's 12px glyph. `Button` reads a glyph size override on its
 * icon wrapper, not from a `[&_svg]:size-*` on the button box.
 */
const REMOVE_GLYPH_CLASS = "size-3 [&_svg]:size-3";

interface AttachmentTileProps {
  id: string;
  filename: string;
  /** Decoded image URL. `null` while the upload is still in flight. */
  previewUrl: string | null;
  /** Spinner face, and the control reads "cancel" instead of "remove". */
  uploading?: boolean;
  onRemove: (id: string) => void;
  /** Opens the full-screen preview. Only honoured once `previewUrl` is set. */
  onPreview?: () => void;
  /** Called when the browser cannot decode the preview. Lets the owner drop
   *  the tile for a chip, which still names the file. */
  onPreviewError?: () => void;
  /** The composer's press guard for the remove control. */
  onRemoveMouseDown?: MouseEventHandler<HTMLElement>;
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
  uploading = false,
  onRemove,
  onPreview,
  onPreviewError,
  onRemoveMouseDown,
}: AttachmentTileProps) {
  const { t } = useTranslation("chat");

  return (
    <div
      data-slot="attachment-tile"
      title={filename}
      className="relative size-[100px] shrink-0 overflow-hidden rounded-[14px] bg-[var(--surface-base)]"
    >
      {previewUrl !== null ? (
        <button
          type="button"
          className="block size-full cursor-pointer"
          aria-label={t("attachmentTile.preview", { filename })}
          onClick={onPreview}
          disabled={onPreview == null}
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
        iconOnlyGlyphClassName={REMOVE_GLYPH_CLASS}
        aria-label={t(
          uploading ? "attachmentTile.cancelUpload" : "attachmentTile.remove",
          { filename },
        )}
        onMouseDown={onRemoveMouseDown}
        onClick={(event) => {
          event.stopPropagation();
          onRemove(id);
        }}
      />
    </div>
  );
}
