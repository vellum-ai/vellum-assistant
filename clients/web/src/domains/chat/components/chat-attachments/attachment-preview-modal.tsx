import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, FileIcon, Loader2, X } from "lucide-react";
import type { FC, KeyboardEvent, MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { fetchAttachmentContentBlob } from "@/domains/chat/components/chat-attachments/download-attachment";
import { Button, Typography } from "@vellumai/design-library";

import { PdfPreview } from "@/domains/chat/components/chat-attachments/pdf-preview";
import { PreviewMessageCard } from "@/domains/chat/components/chat-attachments/preview-message-card";
import { TextPreview } from "@/domains/chat/components/chat-attachments/text-preview";
import { formatAttachmentSize } from "@/domains/chat/components/chat-attachments/utils";
import type { DisplayAttachment } from "@/types/attachment-types";

// File extensions routed to the inline text preview even when the upstream
// MIME type is generic (e.g. application/octet-stream).
const TEXT_PREVIEW_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "json",
  "md",
  "sh",
  "bash",
  "html",
  "css",
  "yaml",
  "yml",
  "txt",
]);

const TEXT_PREVIEW_APPLICATION_MIMES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
]);

const getExtension = (filename: string): string => {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
};

interface AttachmentPreviewModalProps {
  open: boolean;
  onClose: () => void;
  attachment: DisplayAttachment;
  /** When set, the modal will fetch missing content from
   *  /v1/assistants/{assistantId}/attachments/{attachment.id}/content. */
  assistantId?: string | null;
  /** Full list of sibling attachments for gallery navigation. When provided
   *  with more than one entry, prev/next arrows and a position counter render. */
  siblingAttachments?: DisplayAttachment[];
  /** Called when the user navigates to a different attachment via the gallery
   *  arrows. The parent swaps the active `attachment` prop in response. */
  onNavigate?: (attachment: DisplayAttachment) => void;
}

/**
 * Full-screen preview modal for chat attachments. Handles images, videos, and
 * a non-previewable fallback card. When `previewUrl` is missing but
 * `assistantId` is provided, the modal lazily fetches the attachment content
 * from the backend, converts it to a blob URL, and revokes the URL on
 * cleanup. Dismissable via backdrop click, close button, or Escape key.
 *
 * Async fetch pattern modeled on `app/admin/AttachmentLightbox.tsx`.
 */
export const AttachmentPreviewModal: FC<AttachmentPreviewModalProps> = ({
  open,
  onClose,
  attachment,
  assistantId,
  siblingAttachments,
  onNavigate,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      closeButtonRef.current?.focus();
    }
  }, [open]);

  // Synthetic IDs from the text-parsing history fallback
  // (parseAttachmentSummariesFromContent) can never resolve against the
  // daemon's content endpoint, so we never fetch them — we show a clear message
  // instead of a misleading network error.
  const isRehydrated =
    !attachment.previewUrl && attachment.id.startsWith("rehydrated:");

  // Fetch content from the daemon only when there's no inline previewUrl and we
  // have a real, resolvable id to fetch with.
  const shouldFetch =
    open &&
    !attachment.previewUrl &&
    !!assistantId &&
    !!attachment.id &&
    !isRehydrated;

  const { data: blob, isError } = useQuery({
    // The attachment id is stable and unique, so it is the cache key — reopening
    // the same attachment reuses the fetched blob instead of refetching.
    queryKey: ["attachmentContent", assistantId, attachment.id],
    queryFn: async () => {
      const data = await fetchAttachmentContentBlob(assistantId!, attachment.id);
      if (!data) {
        throw new Error("Failed to load file");
      }
      return data;
    },
    enabled: shouldFetch,
    staleTime: Infinity,
    retry: false,
  });

  // Hold the fetched blob as an object URL for the media/text renderers, and
  // revoke it when the blob changes or the modal unmounts.
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [blob]);

  const effectiveUrl = attachment.previewUrl ?? objectUrl;

  // A full-size image whose bytes the browser can't decode (e.g. HEIC on
  // Chromium, even after fetching the stored original) falls through to the
  // non-image fallback card instead of rendering the broken-image glyph.
  const [decodeFailedUrl, setDecodeFailedUrl] = useState<string | null>(null);

  // Loading until there's a usable URL: covers the fetch and the one-render gap
  // between the blob arriving and its object URL being created.
  const isLoadingPreview = shouldFetch && !objectUrl && !isError;

  const previewError = isRehydrated
    ? "Preview unavailable — file content was not preserved in chat history."
    : isError
      ? "Failed to load preview."
      : null;

  const currentIndex = useMemo(() => {
    if (!siblingAttachments || siblingAttachments.length <= 1) return -1;
    return siblingAttachments.findIndex((a) => a.id === attachment.id);
  }, [siblingAttachments, attachment.id]);

  const hasGallery = currentIndex !== -1 && siblingAttachments != null && siblingAttachments.length > 1;

  const goToPrev = useCallback(() => {
    if (!hasGallery || !siblingAttachments || !onNavigate) return;
    const prevIndex = (currentIndex - 1 + siblingAttachments.length) % siblingAttachments.length;
    onNavigate(siblingAttachments[prevIndex]!);
  }, [hasGallery, siblingAttachments, currentIndex, onNavigate]);

  const goToNext = useCallback(() => {
    if (!hasGallery || !siblingAttachments || !onNavigate) return;
    const nextIndex = (currentIndex + 1) % siblingAttachments.length;
    onNavigate(siblingAttachments[nextIndex]!);
  }, [hasGallery, siblingAttachments, currentIndex, onNavigate]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && hasGallery) {
        e.preventDefault();
        goToPrev();
      } else if (e.key === "ArrowRight" && hasGallery) {
        e.preventDefault();
        goToNext();
      }
    },
    [onClose, goToPrev, goToNext, hasGallery],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  const handleDownload = useCallback(async () => {
    if (!effectiveUrl) return;
    const { saveFile } = await import("@/runtime/native-file");
    await saveFile(effectiveUrl, attachment.filename);
  }, [effectiveUrl, attachment.filename]);

  if (!open) {
    return null;
  }

  const mime = attachment.mimeType.toLowerCase();
  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  // Some uploads come through with a generic application/octet-stream MIME;
  // fall back to the filename extension so a real PDF still gets the inline
  // preview branch.
  const isPdf =
    mime === "application/pdf" ||
    (mime === "application/octet-stream" &&
      attachment.filename.toLowerCase().endsWith(".pdf"));
  const extension = getExtension(attachment.filename);
  // Route by MIME first (text/* and the JSON/JS/XML application types), then
  // fall back to the file extension for uploads that arrive as
  // application/octet-stream. PDF/image/video branches above already win for
  // their own types.
  const isText =
    mime.startsWith("text/") ||
    TEXT_PREVIEW_APPLICATION_MIMES.has(mime) ||
    TEXT_PREVIEW_EXTENSIONS.has(extension);

  const renderContent = () => {
    if (isLoadingPreview) {
      return (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-white/70" />
        </div>
      );
    }

    if (previewError) {
      return (
        <PreviewMessageCard
          message={previewError}
          filename={attachment.filename}
          onDownload={handleDownload}
          downloadDisabled={!effectiveUrl}
        />
      );
    }

    if (isPdf && effectiveUrl) {
      return <PdfPreview url={effectiveUrl} />;
    }

    if (isImage && effectiveUrl && decodeFailedUrl !== effectiveUrl) {
      return (
        <img
          src={effectiveUrl}
          alt={attachment.filename}
          onError={() => setDecodeFailedUrl(effectiveUrl)}
          className="max-h-[80vh] max-w-[90vw] rounded object-contain"
        />
      );
    }

    if (isVideo && effectiveUrl) {
      return (
        <video
          data-testid="video-preview"
          src={effectiveUrl}
          poster={attachment.thumbnailUrl ?? undefined}
          controls
          className="max-h-[80vh] max-w-[90vw] rounded"
        />
      );
    }

    if (isText && effectiveUrl) {
      return (
        <TextPreview
          url={effectiveUrl}
          filename={attachment.filename}
          mimeType={attachment.mimeType}
          sizeBytes={attachment.sizeBytes}
        />
      );
    }

    return (
      <div className="flex w-full max-w-sm flex-col items-center rounded-lg border border-white/15 bg-white/[0.08] p-8 text-center">
        <FileIcon className="h-16 w-16 text-white/60" />
        <p className="mt-4 text-body-medium-default text-white/90">
          {attachment.filename}
        </p>
        <p className="mt-1 text-body-small-default text-white/60">
          {formatAttachmentSize(attachment.sizeBytes)}
        </p>
        <Button
          variant="ghost"
          leftIcon={<Download />}
          onClick={handleDownload}
          disabled={!effectiveUrl}
          aria-label={`Download ${attachment.filename}`}
          className="mt-4 text-white/70 hover:bg-white/10 hover:text-white max-md:bg-transparent"
          tintColor="currentColor"
        >
          Download
        </Button>
      </div>
    );
  };

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${attachment.filename}`}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 [-webkit-app-region:no-drag]"
      style={{
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
        paddingBottom:
          "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
        paddingLeft:
          "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
        paddingRight:
          "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
      }}
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
    >
      {/* Top chrome: file size (left), filename (center), download + close
          (right). Absolute children anchor to the overlay's padding box, so the
          parent's safe-area paddingTop does not offset them — the bar carries
          the top inset itself to clear the notch/status bar. */}
      <div
        className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 px-4"
        style={{
          paddingTop:
            "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 1rem)",
        }}
      >
        <Typography
          variant="body-small-default"
          className="w-11 shrink-0 truncate text-white/50"
        >
          {formatAttachmentSize(attachment.sizeBytes)}
        </Typography>
        <Typography
          as="div"
          variant="body-medium-lighter"
          className="min-w-0 flex-1 truncate text-center text-white/90"
        >
          {attachment.filename}
        </Typography>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            iconOnly={<Download />}
            onClick={handleDownload}
            disabled={!effectiveUrl}
            aria-label={`Download ${attachment.filename}`}
            className="h-11 w-11 rounded-full bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
            tintColor="currentColor"
          />
          <Button
            ref={closeButtonRef}
            variant="ghost"
            iconOnly={<X />}
            expandOnMobile={false}
            onClick={onClose}
            aria-label="Close preview"
            className="h-11 w-11 rounded-full bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
            tintColor="currentColor"
          />
        </div>
      </div>

      {hasGallery && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 items-center justify-between px-4">
          <Button
            variant="ghost"
            iconOnly={<ChevronLeft />}
            expandOnMobile={false}
            onClick={goToPrev}
            aria-label="Previous attachment"
            className="pointer-events-auto h-11 w-11 rounded-full bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
            tintColor="currentColor"
          />
          <Button
            variant="ghost"
            iconOnly={<ChevronRight />}
            expandOnMobile={false}
            onClick={goToNext}
            aria-label="Next attachment"
            className="pointer-events-auto h-11 w-11 rounded-full bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
            tintColor="currentColor"
          />
        </div>
      )}

      <div
        className="flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {renderContent()}
      </div>

      {hasGallery && (
        // Position counter, centered ~32px above the bottom safe-area line.
        // Absolute children ignore the overlay's safe-area paddingBottom, so the
        // counter carries the bottom inset itself.
        <div
          className="absolute inset-x-0 bottom-0 z-10 flex justify-center"
          style={{
            paddingBottom:
              "calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 2rem)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <Typography variant="body-small-default" className="text-white/50">
            {currentIndex + 1} / {siblingAttachments!.length}
          </Typography>
        </div>
      )}
    </div>,
    document.body,
  );
};
