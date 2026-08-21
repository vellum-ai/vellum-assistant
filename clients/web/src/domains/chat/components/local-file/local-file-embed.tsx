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

import { toast } from "@vellumai/design-library";
import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { LocalFileCard } from "@/domains/chat/components/local-file/local-file-card";
import { localFileKindFromFilename } from "@/domains/chat/components/local-file/local-file-icon";
import { MAX_INLINE_MEDIA_BYTES } from "@/domains/chat/components/local-file/local-file-limits";
import { LocalFileMenu } from "@/domains/chat/components/local-file/local-file-menu";
import { resolveLocalFileTarget } from "@/domains/chat/components/local-file/local-file-target";
import { useTranslation } from "@/i18n";
import {
  useLocalFileInfo,
  useLocalFileObjectUrl,
} from "@/domains/chat/components/local-file/use-local-file-info";

const MEDIA_CLASSES =
  "max-h-[400px] max-w-full rounded-lg border border-[var(--border-element)] object-contain";

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
    <span
      data-reveal-row=""
      className="relative my-2 inline-block max-w-full align-top"
    >
      {children}
      <span
        data-reveal=""
        className="absolute right-2 top-2 rounded-md bg-[var(--surface-lift)]"
      >
        {menu}
      </span>
    </span>
  );
}

export function LocalFileEmbed({
  href,
  alt,
  assistantId,
}: LocalFileEmbedProps): ReactNode {
  const { t } = useTranslation("chat");
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
      toast.error(t("localFileEmbed.pictureInPictureUnavailable"));
      return;
    }
    el.addEventListener(
      "leavepictureinpicture",
      () => {
        el.disablePictureInPicture = true;
      },
      { once: true },
    );
  }, [t]);

  const ready = info.status === "ready" ? info : null;
  const filename = ready?.filename ?? target.filename;
  // Without a probe result the filename is all we have to pick an icon by.
  const kind = ready?.kind ?? localFileKindFromFilename(filename);
  const sizeBytes = ready?.sizeBytes ?? null;
  const isOversized = sizeBytes !== null && sizeBytes > MAX_INLINE_MEDIA_BYTES;
  // Only playable media embeds inline: a page preview inside the transcript
  // reads as an attempt to be the document, so PDFs fall through to the card
  // and their link opens the drawer preview.
  const wantsMedia =
    ready !== null &&
    (kind === "image" || kind === "video" || kind === "audio") &&
    !isOversized &&
    failedHref !== href;

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
    <Skeleton
      as="span"
      role="status"
      aria-label={t("localFileEmbed.loadingAria", { label: mediaLabel })}
      className="my-2 inline-block h-7 w-40 rounded-lg align-middle"
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
          // Browser media-control tokens, not user-facing copy.
          // eslint-disable-next-line local/no-untranslated-strings -- HTML controlsList tokens
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

  if (kind === "audio") {
    return (
      <span className="my-2 flex w-full max-w-md items-center gap-2">
        <audio
          src={url}
          controls
          // eslint-disable-next-line local/no-untranslated-strings -- HTML controlsList tokens
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
