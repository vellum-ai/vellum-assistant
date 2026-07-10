import { useQuery } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Tooltip } from "@vellumai/design-library";

import {
  downloadAttachment,
  fetchAttachmentContentBlob,
} from "@/domains/chat/components/chat-attachments/download-attachment";
import { estimateBase64Bytes } from "@/domains/chat/components/chat-attachments/utils";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayAttachment } from "@/types/attachment-types";

function inferImageMimeType(base64: string): string {
  const normalized = base64.replace(/\s/g, "");
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

const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;

/**
 * Normalize a tool-result image payload — either raw base64 or a full
 * `data:image/...;base64,` URI — into its MIME type, bare base64 payload, and
 * a `data:` URL `src`. Data URIs carry their MIME type in the prefix; raw
 * payloads fall back to magic-byte sniffing.
 */
function normalizeToolResultImage(imageData: string): {
  mimeType: string;
  base64: string;
  src: string;
} {
  const trimmed = imageData.trim();
  const dataUriMatch = trimmed.match(DATA_URI_RE);
  if (dataUriMatch) {
    return {
      mimeType: dataUriMatch[1]!.toLowerCase(),
      base64: trimmed.slice(dataUriMatch[0].length),
      src: trimmed,
    };
  }
  const mimeType = inferImageMimeType(trimmed);
  return {
    mimeType,
    base64: trimmed,
    src: `data:${mimeType};base64,${trimmed}`,
  };
}

/**
 * Derive a human-friendly filename prefix from the tool name that produced the
 * image. Mirrors the daemon's `toolNameToFilePrefix` in
 * `assistant/src/daemon/assistant-attachments.ts` so mid-turn names share the
 * server's `<tool-prefix>` base (see {@link buildToolResultAttachments} for
 * where the client intentionally adds a multi-image index suffix).
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
 * Project a message's tool-result images into {@link DisplayAttachment}
 * objects.
 *
 * Two shapes flow in. A tool-result image persisted as a workspace reference
 * arrives as an entry in `imageAttachmentIds` — a real attachment id with no
 * inline bytes, so the attachment carries `previewUrl: null` and the strip
 * fetches the content by id on render (mirroring the preview modal's lazy
 * fetch). Legacy inline base64 (`imageDataList` / the deprecated `imageData`)
 * is embedded directly as a data-URL `previewUrl`, rendered without a daemon
 * fetch. A daemon emits ids for referenced media and base64 for legacy rows,
 * never both for the same image.
 *
 * Filenames use the server's `<tool-prefix>.<ext>` naming; a tool that emits
 * more than one image additionally gets an index suffix so the names stay
 * distinct (the server keeps same-named attachments apart by id instead).
 * Referenced entries have no wire-carried MIME/size, so they default to a
 * generic image type — the fetched blob supplies the real bytes for preview
 * and download.
 */
function buildToolResultAttachments(
  toolCalls: ChatMessageToolCall[],
): DisplayAttachment[] {
  const attachments: DisplayAttachment[] = [];
  let globalIndex = 0;
  for (const tc of toolCalls) {
    const refIds = tc.imageAttachmentIds ?? [];
    const base64Images = tc.imageDataList?.length
      ? tc.imageDataList
      : tc.imageData
        ? [tc.imageData]
        : [];
    const total = refIds.length + base64Images.length;
    const prefix = toolNameToFilePrefix(tc.name);
    let localIndex = 0;
    const nameFor = (ext: string): string => {
      const base = tc.name ? prefix : `image-${globalIndex}`;
      const suffix = total > 1 ? `-${localIndex}` : "";
      return `${base}${suffix}.${ext}`;
    };
    refIds.forEach((attachmentId) => {
      globalIndex += 1;
      localIndex += 1;
      attachments.push({
        id: attachmentId,
        filename: nameFor("png"),
        mimeType: "image/png",
        sizeBytes: 0,
        previewUrl: null,
      });
    });
    base64Images.forEach((imageData) => {
      globalIndex += 1;
      localIndex += 1;
      const { mimeType, base64, src } = normalizeToolResultImage(imageData);
      const ext = mimeType.split("/")[1] ?? "png";
      attachments.push({
        id: `tool-image:${tc.id}:${localIndex}`,
        filename: nameFor(ext),
        mimeType,
        sizeBytes: estimateBase64Bytes(base64),
        previewUrl: src,
      });
    });
  }
  return attachments;
}

const IMAGE_CLASS =
  "max-h-72 max-w-full rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] object-contain sm:max-w-[28rem]";

/**
 * Renders the inline `<img>` for one tool-result image. An attachment with an
 * inline `previewUrl` (legacy base64) renders straight from that data URL with
 * no daemon round-trip — and, crucially, without depending on a React Query
 * context. A workspace-referenced attachment (`previewUrl: null` + a real id)
 * defers to {@link ReferencedToolResultImage}, which owns the lazy fetch.
 */
const ToolResultImageThumb: FC<{
  attachment: DisplayAttachment;
  assistantId?: string | null;
}> = ({ attachment, assistantId }) => {
  if (attachment.previewUrl) {
    return (
      <img
        data-testid="tool-result-image"
        src={attachment.previewUrl}
        alt={attachment.filename}
        className={IMAGE_CLASS}
      />
    );
  }
  return (
    <ReferencedToolResultImage attachment={attachment} assistantId={assistantId} />
  );
};

/**
 * Lazily fetches a workspace-referenced tool-result image by attachment id and
 * renders it from an object URL, revoked on unmount. Uses the same fetch/cache
 * key as the preview modal, so opening the modal reuses the already-fetched
 * blob. Until the fetch resolves (or when no assistant id is available to fetch
 * with), a spinner placeholder holds the slot.
 */
const ReferencedToolResultImage: FC<{
  attachment: DisplayAttachment;
  assistantId?: string | null;
}> = ({ attachment, assistantId }) => {
  const shouldFetch = !!assistantId && !!attachment.id;

  const { data: blob, isError } = useQuery({
    queryKey: ["attachmentContent", assistantId, attachment.id],
    queryFn: async () => {
      const data = await fetchAttachmentContentBlob(
        assistantId!,
        attachment.id,
      );
      if (!data) {
        throw new Error("Failed to load image");
      }
      return data;
    },
    enabled: shouldFetch,
    staleTime: Infinity,
    retry: false,
  });

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

  if (!objectUrl) {
    return (
      <div
        data-testid="tool-result-image-placeholder"
        className={`flex h-40 w-40 items-center justify-center ${IMAGE_CLASS}`}
      >
        {!isError && (
          <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
        )}
      </div>
    );
  }

  return (
    <img
      data-testid="tool-result-image"
      src={objectUrl}
      alt={attachment.filename}
      className={IMAGE_CLASS}
    />
  );
};

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
 * {@link MessageAttachmentSquare}. Referenced images (from `imageAttachmentIds`)
 * are daemon-id-backed and fetch their bytes by id on render; legacy inline
 * base64 images render straight from their data URL.
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

  const handleDownload = useCallback(
    (att: DisplayAttachment) => {
      // Referenced images (no inline `previewUrl`) fetch their bytes by id via
      // the daemon content endpoint; legacy base64 images have their data URL in
      // `previewUrl`, so downloading straight from it skips a needless fetch.
      void downloadAttachment(att, att.previewUrl ? undefined : assistantId);
    },
    [assistantId],
  );

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
            <ToolResultImageThumb attachment={att} assistantId={assistantId} />
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
