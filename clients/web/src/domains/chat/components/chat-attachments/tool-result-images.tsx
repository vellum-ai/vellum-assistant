import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { FC, MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AttachmentDownloadOverlay } from "@/domains/chat/components/chat-attachments/attachment-download-overlay";
import {
  downloadAttachment,
  fetchAttachmentContentBlob,
} from "@/domains/chat/components/chat-attachments/download-attachment";
import { estimateBase64Bytes } from "@/domains/chat/components/chat-attachments/utils";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import { sniffMimeType } from "@/domains/chat/utils/mime-sniff";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayAttachment } from "@/types/attachment-types";

/** Base64 characters decoded for sniffing: enough for every image signature. */
const BASE64_HEAD_CHARS = 48;

/** Decode the leading bytes of a base64 payload, or nothing when undecodable. */
function decodeBase64Head(base64: string): Uint8Array {
  const whole = base64.slice(0, BASE64_HEAD_CHARS);
  const aligned = whole.slice(0, whole.length - (whole.length % 4));
  if (aligned.length === 0) {
    return new Uint8Array(0);
  }
  try {
    const binary = atob(aligned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * MIME type of a raw base64 image payload. Tool-result images are images by
 * construction, so a sniff that lands outside `image/*` (or comes back
 * inconclusive) falls back to PNG rather than mislabelling the data URL.
 */
function inferImageMimeType(base64: string): string {
  const normalized = base64.replace(/\s/g, "");
  const sniffed = sniffMimeType(decodeBase64Head(normalized));
  return sniffed?.startsWith("image/") ? sniffed : "image/png";
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

const EMPTY_NAMES: ReadonlySet<string> = new Set();

const IMAGE_PATH_RE = /[\w\-./%]+\.(?:png|jpe?g|gif|webp|avif|svg)/gi;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;

/** The final path segment of `path`, percent-decoded and lowercased. */
function fileNameOf(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? path;
  const last = bare.split("/").pop() ?? bare;
  try {
    return decodeURIComponent(last).toLowerCase();
  } catch {
    return last.toLowerCase();
  }
}

/**
 * The image filenames a tool's `result` names, in the order it names them and
 * without repeats.
 *
 * A media tool reports where it wrote each image, then repeats the first path
 * inside the embed hint it gives the model, so first-seen order is the order
 * the images were produced.
 */
function imageFileNamesInResult(result: string | undefined): string[] {
  if (!result) {
    return [];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of result.matchAll(IMAGE_PATH_RE)) {
    const name = fileNameOf(match[0]);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * The image filenames a message's own prose embeds with markdown image syntax.
 *
 * A media skill asks the model to present its result by embedding the saved
 * path in the reply (`![alt](vellum://workspace/...)`), which the markdown
 * renderer draws at full width where the text refers to it. That embed is the
 * presentation, so the mid-turn strip owes nothing for the same file.
 */
export function embeddedImageFileNames(
  contentBlocks: readonly { type: string; text?: string }[] | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const block of contentBlocks ?? []) {
    if (block.type !== "text" || !block.text) {
      continue;
    }
    for (const match of block.text.matchAll(MARKDOWN_IMAGE_RE)) {
      names.add(fileNameOf(match[1]!));
    }
  }
  return names;
}

function toolResultImageInputs(toolCall: ChatMessageToolCall): {
  refIds: string[];
  base64Images: string[];
} {
  const refIds = toolCall.imageAttachmentIds ?? [];
  const base64Images = toolCall.imageDataList?.length
    ? toolCall.imageDataList
    : toolCall.imageData
      ? [toolCall.imageData]
      : [];
  return { refIds, base64Images };
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
  embeddedImageNames: ReadonlySet<string>,
): DisplayAttachment[] {
  const attachments: DisplayAttachment[] = [];
  let globalIndex = 0;
  for (const tc of toolCalls) {
    const { refIds, base64Images } = toolResultImageInputs(tc);
    const total = refIds.length + base64Images.length;
    const prefix = toolNameToFilePrefix(tc.name);
    // Positional: a media tool writes its images to the workspace in the order
    // it reports them, so image `i` of this call is the file named `i`th in its
    // result. An image whose file the reply embeds is presented there instead.
    const savedNames = embeddedImageNames.size
      ? imageFileNamesInResult(tc.result)
      : [];
    const isEmbedded = (index: number): boolean => {
      const name = savedNames[index];
      return name !== undefined && embeddedImageNames.has(name);
    };
    let imageIndex = -1;
    let localIndex = 0;
    const nameFor = (ext: string): string => {
      const base = tc.name ? prefix : `image-${globalIndex}`;
      const suffix = total > 1 ? `-${localIndex}` : "";
      return `${base}${suffix}.${ext}`;
    };
    refIds.forEach((attachmentId) => {
      globalIndex += 1;
      localIndex += 1;
      imageIndex += 1;
      if (isEmbedded(imageIndex)) {
        return;
      }
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
      imageIndex += 1;
      if (isEmbedded(imageIndex)) {
        return;
      }
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

/**
 * The tool-result images `toolCalls` still owe a mid-turn strip.
 *
 * An image must render exactly once, and a turn has two other places that can
 * already be rendering it:
 *
 *  - The message's own prose, when the reply embeds the saved path as a
 *    markdown image. That embed is the presentation the media skills ask for,
 *    drawn full width where the text refers to it, so an image whose file the
 *    reply embeds is dropped here (see {@link embeddedImageFileNames}).
 *  - The end-of-turn `messageAttachments` chips below the body. A referenced
 *    image carries a real workspace attachment id, so it is matched by id and
 *    dropped only when that same image is among them. Legacy inline base64 has
 *    no id to match on (its `tool-image:` key is synthesized client-side and
 *    can never equal an attachment id), so it falls back to a coarser rule:
 *    any end-of-turn attachments at all suppress it. That coarse rule is
 *    scoped to the legacy shape so one unrelated attachment (a file the turn
 *    wrote, a user upload on the same message) cannot suppress every
 *    referenced image the turn produced.
 *
 * Pure, and the single source of truth for both the render and the transcript's
 * decision to pin the group holding it, so the two cannot disagree.
 */
export function resolveToolResultImages(
  toolCalls: ChatMessageToolCall[],
  messageAttachments: readonly DisplayAttachment[] | undefined,
  embeddedImageNames: ReadonlySet<string> = EMPTY_NAMES,
): DisplayAttachment[] {
  const shown = buildToolResultAttachments(toolCalls, embeddedImageNames);
  if (!messageAttachments?.length) {
    return shown;
  }
  const attachedIds = new Set(messageAttachments.map((a) => a.id));
  return shown.filter(
    (image) => image.previewUrl === null && !attachedIds.has(image.id),
  );
}

export function hasToolResultImages(toolCalls: ChatMessageToolCall[]): boolean {
  return toolCalls.some((toolCall) => {
    const { refIds, base64Images } = toolResultImageInputs(toolCall);
    return refIds.length > 0 || base64Images.length > 0;
  });
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
    <ReferencedToolResultImage
      attachment={attachment}
      assistantId={assistantId}
    />
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
  /** The message's end-of-turn attachments, which render their own interactive
   *  chips below the body. An image already shown there is dropped from this
   *  strip. See {@link resolveToolResultImages} for how the two are matched. */
  messageAttachments?: readonly DisplayAttachment[];
  /** Image filenames the message's own prose embeds, from
   *  {@link embeddedImageFileNames}. An embedded image is presented there. */
  embeddedImageNames?: ReadonlySet<string>;
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
  messageAttachments,
  embeddedImageNames,
  assistantId,
}) => {
  const attachments = useMemo(
    () =>
      resolveToolResultImages(
        toolCalls,
        messageAttachments,
        embeddedImageNames,
      ),
    [toolCalls, messageAttachments, embeddedImageNames],
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
            data-reveal-row=""
            className="group relative w-fit cursor-pointer"
          >
            <ToolResultImageThumb attachment={att} assistantId={assistantId} />
            <AttachmentDownloadOverlay
              filename={att.filename}
              onDownload={(e: MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                handleDownload(att);
              }}
              className="rounded-md"
            />
          </div>
        ))}
      </div>
      {previewModal}
    </>
  );
};
