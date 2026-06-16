import { Download, FileIcon, Loader2, X } from "lucide-react";
import type { FC, KeyboardEvent, MouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";
import { Button, Typography } from "@vellumai/design-library";

import { PdfPreview } from "@/domains/chat/components/chat-attachments/pdf-preview";
import { TextPreview } from "@/domains/chat/components/chat-attachments/text-preview";
import { formatAttachmentSize } from "@/domains/chat/components/chat-attachments/utils";

// File extensions we route to the TextPreview branch even when the upstream
// MIME type is something generic like application/octet-stream. Keep in sync
// with the language map inside `_TextPreview.tsx`.
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
  attachment: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    previewUrl: string | null;
  };
  /** When set, the modal will fetch missing content from
   *  /v1/assistants/{assistantId}/attachments/{attachment.id}/content. */
  assistantId?: string | null;
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
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      closeButtonRef.current?.focus();
    }
  }, [open]);

  // Lazily fetch attachment content as a blob when no previewUrl is supplied.
  useEffect(() => {
    if (!open) return;
    if (attachment.previewUrl) return;
    if (!assistantId || !attachment.id) return;

    // Synthetic IDs created by the text-parsing fallback
    // (parseAttachmentSummariesFromContent) can never resolve against
    // the daemon's content endpoint. Skip the doomed fetch and show a
    // clear message instead of a misleading network error.
    if (attachment.id.startsWith("rehydrated:")) {
      setPreviewError(
        "Preview unavailable — file content was not preserved in chat history.",
      );
      return;
    }

    let revoked = false;

    const loadPreview = async () => {
      setIsLoadingPreview(true);
      setPreviewError(null);
      setObjectUrl(null);

      try {
        const { data, error } = await attachmentsByIdContentGet({
          path: { assistant_id: assistantId, id: attachment.id },
          parseAs: "blob",
          throwOnError: false,
        });
        if (error || !(data instanceof Blob)) {
          throw new Error("Failed to load file");
        }
        if (revoked) return;

        const url = URL.createObjectURL(data);
        setObjectUrl(url);
      } catch {
        if (!revoked) {
          setPreviewError("Failed to load preview.");
        }
      } finally {
        if (!revoked) {
          setIsLoadingPreview(false);
        }
      }
    };

    void loadPreview();

    return () => {
      revoked = true;
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setIsLoadingPreview(false);
      setPreviewError(null);
    };
  }, [open, attachment.previewUrl, attachment.id, assistantId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Mark the key as consumed so the window-level Escape listener
        // (which closes the right-hand side panel) doesn't also fire.
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  const effectiveUrl = attachment.previewUrl ?? objectUrl;

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
        <div className="w-full max-w-sm rounded-lg border border-white/15 bg-white/[0.08] p-8 text-center">
          <p className="text-body-medium-lighter text-white/80">
            {previewError}
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
    }

    if (isPdf && effectiveUrl) {
      return <PdfPreview url={effectiveUrl} />;
    }

    if (isImage && effectiveUrl) {
      return (
        <img
          src={effectiveUrl}
          alt={attachment.filename}
          className="max-h-[80vh] max-w-[90vw] rounded object-contain"
        />
      );
    }

    if (isVideo && effectiveUrl) {
      return (
        <video
          src={effectiveUrl}
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
      <Button
        ref={closeButtonRef}
        variant="ghost"
        iconOnly={<X />}
        expandOnMobile={false}
        onClick={onClose}
        aria-label="Close preview"
        className="absolute right-4 top-4 z-10 h-11 w-11 rounded-full bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
        tintColor="currentColor"
      />

      <div
        className="flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {renderContent()}
      </div>

      <div
        className="mt-4 flex w-full max-w-[800px] items-center justify-between rounded-lg px-4 py-2"
        style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Typography
            variant="body-medium-lighter"
            className="truncate text-white/90"
          >
            {attachment.filename}
          </Typography>
          <Typography
            variant="body-small-default"
            className="shrink-0 text-white/50"
          >
            {formatAttachmentSize(attachment.sizeBytes)}
          </Typography>
        </div>
        <Button
          variant="ghost"
          iconOnly={<Download />}
          onClick={handleDownload}
          disabled={!effectiveUrl}
          aria-label={`Download ${attachment.filename}`}
          className="shrink-0 text-white/70 hover:bg-white/10 hover:text-white max-md:bg-transparent max-md:hover:bg-white/10 max-md:active:bg-white/10"
          tintColor="currentColor"
        />
      </div>
    </div>,
    document.body,
  );
};
