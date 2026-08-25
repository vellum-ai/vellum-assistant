
import { useTranslation } from "@/i18n";
/**
 * The download affordance laid over an attachment thumbnail, for the image
 * grids and the file squares alike.
 *
 * Where the device can hover, a scrim dims the artwork and the button rides on
 * top of it. Where it cannot, a scrim would sit there permanently and hide the
 * thing it decorates, so the button appears alone with a chip of its own behind
 * it: a control the device cannot reveal has to be present, and the thumbnail
 * still has to be readable.
 *
 * The thumbnail must carry `data-reveal-row` for the button's reveal conditions
 * to resolve, Tailwind's `group` class for the scrim's, and must be a
 * positioning context. The scrim is decoration rather than an affordance: it
 * appears on hover and has no touch counterpart, so it is not part of the
 * reveal contract the button uses.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover
 * @see https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus
 */

import { Download } from "lucide-react";
import type { MouseEvent } from "react";
import { Tooltip } from "@vellumai/design-library/components/tooltip";
import { cn } from "@vellumai/design-library/utils/cn";

interface AttachmentDownloadOverlayProps {
  /** Names the control, since the icon alone does not say what it downloads. */
  filename: string;
  onDownload: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Matches the thumbnail's own corner radius. */
  className?: string;
}

export function AttachmentDownloadOverlay({
  filename,
  onDownload,
  className,
}: AttachmentDownloadOverlayProps) {
  const { t } = useTranslation("chat");
  return (
    <div className={cn("pointer-events-none absolute inset-0", className)}>
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-[inherit] bg-black/50 opacity-0 transition-opacity",
          "[@media(hover:hover)]:group-hover:opacity-100",
          "group-focus-within:opacity-100",
        )}
      />
      <Tooltip content={t("attachmentDownloadOverlay.download")}>
        <button
          type="button"
          onClick={onDownload}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={t("attachmentDownloadOverlay.downloadAria", { filename })}
          className={cn(
            "absolute bottom-1 right-1 flex h-6 w-6",
            "items-center justify-center rounded-md text-white/80",
            "transition-colors hover:bg-white/20 hover:text-white",
            // The chip carries the contrast the scrim gives on a hovering
            // device, so the icon stays legible over pale artwork.
            "[@media(hover:none)]:bg-black/50",
          )}
          data-reveal=""
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
