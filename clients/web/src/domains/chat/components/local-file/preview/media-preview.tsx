/**
 * Image, audio, and video playback for the document drawer.
 *
 * One module for the three: they differ only in the element that plays them,
 * and splitting them would cost three chunks to save nothing. The bytes the
 * drawer already holds are re-typed from the filename before they become an
 * object URL, because the daemon's `Content-Type` is derived from the same
 * extension and a generic one would leave the player guessing.
 */

import { useMemo, type ReactNode } from "react";

import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { useBlobObjectUrl } from "@/domains/chat/components/local-file/use-local-file-info";
import { resolveLocalFileType } from "@/domains/chat/utils/mime-sniff";

/** The playable subset of the drawer's preview kinds. */
export type MediaPreviewKind = "image" | "audio" | "video";

interface MediaPreviewProps {
  blob: Blob;
  filename: string;
  kind: MediaPreviewKind;
}

export function MediaPreview({
  blob,
  filename,
  kind,
}: MediaPreviewProps): ReactNode {
  const mime = useMemo(
    () =>
      resolveLocalFileType({
        sniffedMime: null,
        serverMime: blob.type.length > 0 ? blob.type : null,
        filename,
      }).mime,
    [blob, filename],
  );
  const url = useBlobObjectUrl(blob, mime);

  if (url === null) {
    return <PreviewSkeleton />;
  }

  if (kind === "image") {
    return (
      <div className="flex justify-center">
        <img
          src={url}
          alt={filename}
          className="h-auto max-w-full rounded-lg border border-[var(--border-element)]"
        />
      </div>
    );
  }

  if (kind === "audio") {
    // Native download/speed items are suppressed: the drawer's own navbar owns
    // downloading, so the browser's menu would be a second, inconsistent one.
    return (
      <audio
        src={url}
        controls
        controlsList="nodownload noplaybackrate"
        preload="metadata"
        aria-label={filename}
        className="w-full"
      />
    );
  }

  return (
    <video
      src={url}
      controls
      controlsList="nodownload noplaybackrate"
      playsInline
      preload="metadata"
      aria-label={filename}
      className="max-w-full rounded-lg border border-[var(--border-element)]"
    />
  );
}
