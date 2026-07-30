/**
 * Render a markdown reference to a workspace file as inline media when the
 * bytes support it, and as a file card otherwise.
 *
 * The rendering decision comes from the file's classified kind, never from the
 * markdown syntax: `![alt](...)` pointing at a zip renders a card, and a large
 * video renders a card rather than streaming a whole blob into memory.
 *
 * Rendered inside a markdown paragraph, so every wrapper is inline-level.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { toast, Typography } from "@vellumai/design-library";

import { PdfPreview } from "@/domains/chat/components/chat-attachments/pdf-preview";
import {
  formatAttachmentSize,
  middleTruncate,
} from "@/domains/chat/components/chat-attachments/utils";
import { LocalFileCard } from "@/domains/chat/components/local-file/local-file-card";
import {
  LocalFileIcon,
  localFileKindFromFilename,
} from "@/domains/chat/components/local-file/local-file-icon";
import { LocalFileMenu } from "@/domains/chat/components/local-file/local-file-menu";
import { resolveLocalFileTarget } from "@/domains/chat/components/local-file/local-file-target";
import {
  useLocalFileInfo,
  useLocalFileObjectUrl,
} from "@/domains/chat/components/local-file/use-local-file-info";
import type { LocalFileKind } from "@/domains/chat/utils/mime-sniff";

/** The object-URL fetch buffers the whole file in memory, so cap what we load. */
const MAX_INLINE_MEDIA_BYTES = 100 * 1024 * 1024;

const MEDIA_CLASSES =
  "max-h-[400px] max-w-full rounded-lg border border-[var(--border-default)] object-contain";

const MENU_OVERLAY_CLASSES = [
  "pointer-events-none absolute right-2 top-2 rounded-md bg-[var(--surface-lift)] opacity-0 transition-opacity",
  "group-hover/local-media:pointer-events-auto group-hover/local-media:opacity-100",
  "group-focus-within/local-media:pointer-events-auto group-focus-within/local-media:opacity-100",
  "[@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100",
].join(" ");

/** False where the API is missing or policy-disabled (Firefox, some embeds). */
function supportsPictureInPicture(): boolean {
  return (
    typeof document !== "undefined" &&
    "pictureInPictureEnabled" in document &&
    document.pictureInPictureEnabled
  );
}

export interface LocalFileEmbedProps {
  /** Raw markdown destination: `vellum://workspace/...`, `/abs/path`, `./rel`. */
  href: string;
  alt: string;
  assistantId?: string;
}

/** Media plus its hover-revealed overflow menu. */
function MediaFrame({
  children,
  menu,
}: {
  children: ReactNode;
  menu: ReactNode;
}) {
  return (
    <span className="group/local-media relative my-2 inline-block max-w-full align-top">
      {children}
      <span className={MENU_OVERLAY_CLASSES}>{menu}</span>
    </span>
  );
}

interface PdfFrameProps {
  displayName: string;
  filename: string;
  kind: LocalFileKind;
  sizeBytes: number | null;
  /** Rendered inline at the right edge of the header, always visible. */
  menu: ReactNode;
  url: string;
}

/**
 * Pdf embed: a titled header over the capped, scrollable page preview.
 *
 * The menu sits in the header rather than hovering over the pages, where it is
 * both hard to find and easy to mistake for part of the document.
 */
function PdfFrame({
  displayName,
  filename,
  kind,
  sizeBytes,
  menu,
  url,
}: PdfFrameProps): ReactNode {
  const secondary = filename !== displayName ? filename : null;

  return (
    <span className="my-2 flex w-full flex-col overflow-hidden rounded-lg border border-[var(--border-default)]">
      <span
        title={filename}
        className="flex items-center gap-2.5 border-b border-[var(--border-default)] bg-[var(--surface-lift)] p-2"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-sunken)] text-[var(--content-secondary)]">
          <LocalFileIcon kind={kind} filename={filename} className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <Typography
            as="span"
            variant="body-small-default"
            className="truncate text-[var(--content-default)]"
          >
            {middleTruncate(displayName, 40)}
          </Typography>
          {secondary !== null && (
            <Typography
              as="span"
              variant="label-small-default"
              className="truncate text-[var(--content-tertiary)]"
            >
              {secondary}
            </Typography>
          )}
        </span>
        {sizeBytes !== null && (
          <Typography
            as="span"
            variant="label-small-default"
            className="shrink-0 text-[var(--content-disabled)]"
          >
            {formatAttachmentSize(sizeBytes)}
          </Typography>
        )}
        {menu}
      </span>
      {/* PdfPreview sizes its canvases for the fullscreen modal (90vw); pin them to the chat column. */}
      <span className="block max-h-[420px] overflow-y-auto [&_canvas]:w-full!">
        <PdfPreview url={url} />
      </span>
    </span>
  );
}

export function LocalFileEmbed({
  href,
  alt,
  assistantId,
}: LocalFileEmbedProps): ReactNode {
  const target = useMemo(() => resolveLocalFileTarget(href), [href]);
  const info = useLocalFileInfo(target.workspacePath, assistantId);
  // Keyed by href so a reference that changes underneath the same tree
  // position gets a fresh attempt instead of inheriting the failure.
  const [failedHref, setFailedHref] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const togglePictureInPicture = useCallback(async () => {
    const el = videoRef.current;
    if (el === null) {
      return;
    }
    if (document.pictureInPictureElement === el) {
      try {
        await document.exitPictureInPicture();
      } catch {
        // Already closed, or the browser refused; nothing left to undo.
      }
      return;
    }
    // `disablePictureInPicture` hides Chrome's native overflow menu but also
    // rejects the request, so lift it around the call and put it back on exit.
    el.disablePictureInPicture = false;
    try {
      await el.requestPictureInPicture();
    } catch {
      el.disablePictureInPicture = true;
      toast.error("Picture in Picture isn't available");
      return;
    }
    el.addEventListener(
      "leavepictureinpicture",
      () => {
        el.disablePictureInPicture = true;
      },
      { once: true },
    );
  }, []);

  const ready = info.status === "ready" ? info : null;
  const filename = ready?.filename ?? target.filename;
  // Without a probe result the filename is all we have to pick an icon by.
  const kind = ready?.kind ?? localFileKindFromFilename(filename);
  const sizeBytes = ready?.sizeBytes ?? null;
  const isOversized = sizeBytes !== null && sizeBytes > MAX_INLINE_MEDIA_BYTES;
  const wantsMedia =
    ready !== null && kind !== "file" && !isOversized && failedHref !== href;

  const { url, isError } = useLocalFileObjectUrl({
    workspacePath: target.workspacePath,
    mime: ready?.mime ?? null,
    enabled: wantsMedia,
    assistantId,
  });

  const displayName = alt.trim().length > 0 ? alt : filename;
  const mediaLabel = displayName.length > 0 ? displayName : filename;

  const menu = (
    <LocalFileMenu
      workspacePath={target.workspacePath}
      filename={filename}
      assistantId={assistantId}
    />
  );

  const placeholder = (
    <span
      role="status"
      aria-label={`Loading ${mediaLabel}`}
      className="my-2 inline-block h-7 w-40 animate-pulse rounded-lg bg-[var(--surface-lift)] align-middle"
    />
  );

  // Some surfaces render markdown without an assistant id, so the probe can
  // never run there. A plain card (open works, download is disabled) beats an
  // indefinite skeleton.
  if (assistantId === undefined) {
    return (
      <LocalFileCard
        displayName={displayName}
        filename={filename}
        sizeBytes={null}
        kind={kind}
        state="ready"
        workspacePath={target.workspacePath}
        assistantId={assistantId}
      />
    );
  }

  if (info.status === "loading") {
    return placeholder;
  }

  if (info.status === "unavailable") {
    return (
      <LocalFileCard
        displayName={displayName}
        filename={filename}
        sizeBytes={null}
        kind={kind}
        state={info.reason === "missing" ? "missing" : "unavailable"}
        workspacePath={target.workspacePath}
        assistantId={assistantId}
      />
    );
  }

  const readyCard = (
    <LocalFileCard
      displayName={displayName}
      filename={filename}
      sizeBytes={sizeBytes}
      kind={kind}
      state="ready"
      workspacePath={target.workspacePath}
      assistantId={assistantId}
    />
  );

  if (!wantsMedia || isError) {
    return readyCard;
  }

  if (url === null) {
    return placeholder;
  }

  if (kind === "image") {
    return (
      <MediaFrame menu={menu}>
        <img
          src={url}
          alt={alt}
          onError={() => setFailedHref(href)}
          className={MEDIA_CLASSES}
        />
      </MediaFrame>
    );
  }

  if (kind === "video") {
    return (
      <MediaFrame
        menu={
          <LocalFileMenu
            workspacePath={target.workspacePath}
            filename={filename}
            assistantId={assistantId}
            onPictureInPicture={
              supportsPictureInPicture()
                ? () => void togglePictureInPicture()
                : undefined
            }
          />
        }
      >
        {/* Native download/speed/PiP items are suppressed so the browser hides
            its own overflow menu; ours is the single menu on the embed. */}
        <video
          ref={videoRef}
          src={url}
          controls
          controlsList="nodownload noplaybackrate"
          disablePictureInPicture
          playsInline
          preload="metadata"
          aria-label={mediaLabel}
          className={MEDIA_CLASSES}
        />
      </MediaFrame>
    );
  }

  if (kind === "pdf") {
    return (
      <PdfFrame
        displayName={displayName}
        filename={filename}
        kind={kind}
        sizeBytes={sizeBytes}
        menu={menu}
        url={url}
      />
    );
  }

  if (kind === "audio") {
    return (
      <span className="my-2 flex w-full max-w-md items-center gap-2">
        <audio
          src={url}
          controls
          controlsList="nodownload noplaybackrate"
          preload="metadata"
          aria-label={mediaLabel}
          className="min-w-0 flex-1"
        />
        {menu}
      </span>
    );
  }

  return readyCard;
}
