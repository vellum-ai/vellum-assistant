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

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { PdfPreview } from "@/domains/chat/components/chat-attachments/pdf-preview";
import { LocalFileCard } from "@/domains/chat/components/local-file/local-file-card";
import { localFileKindFromFilename } from "@/domains/chat/components/local-file/local-file-icon";
import { LocalFileMenu } from "@/domains/chat/components/local-file/local-file-menu";
import { resolveLocalFileTarget } from "@/domains/chat/components/local-file/local-file-target";
import {
  useLocalFileInfo,
  useLocalFileObjectUrl,
} from "@/domains/chat/components/local-file/use-local-file-info";

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
      <MediaFrame menu={menu}>
        <video
          src={url}
          controls
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
      <MediaFrame menu={menu}>
        {/* PdfPreview sizes its canvases for the fullscreen modal (90vw); pin them to the chat column. */}
        <span className="block max-h-[420px] max-w-full overflow-y-auto rounded-lg border border-[var(--border-default)] [&_canvas]:w-full!">
          <PdfPreview url={url} />
        </span>
      </MediaFrame>
    );
  }

  if (kind === "audio") {
    return (
      <span className="my-2 flex w-full max-w-md items-center gap-2">
        <audio
          src={url}
          controls
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
