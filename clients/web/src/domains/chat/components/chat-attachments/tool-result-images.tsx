import { Download } from "lucide-react";
import type { FC } from "react";
import { useCallback, useMemo } from "react";

import { Tooltip } from "@vellumai/design-library";

import { downloadAttachment } from "@/domains/chat/components/chat-attachments/download-attachment";
import { estimateBase64Bytes } from "@/domains/chat/components/chat-attachments/utils";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayAttachment } from "@/types/attachment-types";

function inferImageMimeType(imageData: string): string {
  const normalized = imageData.replace(/\s/g, "");
  if (normalized.startsWith("iVBORw0KGgo")) {
    return "image/png";
  }
  if (normalized.startsWith("/9j/")) {
    return "image/jpeg";
  }
  if (normalized.startsWith("UklGR")) {
    return "image/webp";
  }
  if (normalized.startsWith("R0lGOD")) {
    return "image/gif";
  }
  if (normalized.startsWith("Qk")) {
    return "image/bmp";
  }
  return "image/png";
}

function toolResultImageSrc(imageData: string, mimeType: string): string {
  const trimmed = imageData.trim();
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
    return trimmed;
  }
  return `data:${mimeType};base64,${trimmed}`;
}

/**
 * Derive a human-friendly filename prefix from the tool name that produced the
 * image. Mirrors the daemon's `toolNameToFilePrefix` in
 * `assistant/src/daemon/assistant-attachments.ts` so a mid-turn image carries
 * the same name the server assigns once the turn completes.
 */
function toolNameToFilePrefix(toolName?: string): string {
  if (!toolName) {
    return "tool-output";
  }
  return toolName
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

/**
 * Project a message's tool-result images into synthetic {@link DisplayAttachment}
 * objects. The base64 payload is embedded directly as a data-URL `previewUrl`,
 * so the preview modal renders it without a daemon fetch and downloads save the
 * bytes straight from the URL. Filenames mirror the server's eventual naming
 * (`<tool-prefix>.png`); a tool that emits more than one image gets an index
 * suffix so the names stay distinct.
 */
function buildToolResultAttachments(
  toolCalls: ChatMessageToolCall[],
): DisplayAttachment[] {
  const attachments: DisplayAttachment[] = [];
  let globalIndex = 0;
  for (const tc of toolCalls) {
    const images = tc.imageDataList?.length
      ? tc.imageDataList
      : tc.imageData
        ? [tc.imageData]
        : [];
    const prefix = toolNameToFilePrefix(tc.name);
    images.forEach((imageData, i) => {
      globalIndex += 1;
      const mimeType = inferImageMimeType(imageData);
      const ext = mimeType.split("/")[1] ?? "png";
      const base = tc.name ? prefix : `image-${globalIndex}`;
      const suffix = images.length > 1 ? `-${i + 1}` : "";
      attachments.push({
        id: `tool-image:${tc.id}:${i}`,
        filename: `${base}${suffix}.${ext}`,
        mimeType,
        sizeBytes: estimateBase64Bytes(imageData),
        previewUrl: toolResultImageSrc(imageData, mimeType),
      });
    });
  }
  return attachments;
}

interface ToolResultImagesProps {
  toolCalls: ChatMessageToolCall[];
  /** When true, end-of-turn `message.attachments` have arrived and render the
   *  interactive chips, so the mid-turn strip suppresses itself. */
  hasAttachments: boolean;
  assistantId?: string | null;
}

/**
 * Inline strip of images returned by tool results during an assistant turn
 * (e.g. `file_read` on an image, generated images). Each image opens the shared
 * full-screen {@link AttachmentPreviewModal} on click and exposes a hover
 * download affordance — the same interactivity end-of-turn attachments get via
 * {@link MessageAttachmentSquare} — while the base64 payloads are not yet
 * persisted attachments with daemon ids.
 */
export const ToolResultImages: FC<ToolResultImagesProps> = ({
  toolCalls,
  hasAttachments,
  assistantId,
}) => {
  const attachments = useMemo(
    () => (hasAttachments ? [] : buildToolResultAttachments(toolCalls)),
    [toolCalls, hasAttachments],
  );
  const { openPreview, previewModal } = useAttachmentPreview(
    assistantId,
    attachments,
  );

  const handleDownload = useCallback((att: DisplayAttachment) => {
    // No daemon id backs these data-URL images, so download saves the
    // `previewUrl` bytes directly (assistantId omitted skips the fetch path).
    void downloadAttachment(att, undefined);
  }, []);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex w-full flex-wrap gap-2">
        {attachments.map((att) => (
          <div
            key={att.id}
            role="button"
            aria-label={att.filename}
            title={att.filename}
            tabIndex={0}
            onClick={() => openPreview(att)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openPreview(att);
              }
            }}
            className="group/toolimg relative w-fit cursor-pointer"
          >
            <img
              data-testid="tool-result-image"
              src={att.previewUrl!}
              alt={att.filename}
              className="max-h-72 max-w-full rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] object-contain sm:max-w-[28rem]"
            />
            <div className="pointer-events-none absolute inset-0 rounded-md bg-black/50 opacity-0 transition-opacity group-hover/toolimg:pointer-events-auto group-hover/toolimg:opacity-100 group-focus-within/toolimg:pointer-events-auto group-focus-within/toolimg:opacity-100">
              <Tooltip content="Download">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDownload(att);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  aria-label={`Download ${att.filename}`}
                  className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </div>
          </div>
        ))}
      </div>
      {previewModal}
    </>
  );
};
