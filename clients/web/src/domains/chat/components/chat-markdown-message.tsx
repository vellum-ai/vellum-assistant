/**
 * Chat-domain MarkdownMessage that composes the design-library primitive
 * with OAuth-aware link handling, vellum:// file link support, and inline
 * image previews for external URLs and workspace/host file attachments.
 */

import {
  type AnchorHTMLAttributes,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { attachmentsByIdContentGet } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import {
  type MarkdownImageComponent,
  MarkdownMessage,
  type MarkdownMessageProps,
} from "@vellumai/design-library";
import type { DisplayAttachment } from "@/types/attachment-types";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import { defaultUrlTransform } from "react-markdown";

import {
  openMarkdownOAuthLinkInPopup,
  shouldOpenMarkdownLinkInOAuthPopup,
} from "@/domains/chat/utils/oauth-popup-links";
import { RedactedCredentialChip } from "@/domains/chat/components/redacted-credential-chip";
import {
  REDACTED_CREDENTIAL_TAG,
  rehypeRedactedCredential,
} from "@/domains/chat/utils/rehype-redacted-credential";
import { rehypeStreamWordFade } from "@/domains/chat/utils/rehype-stream-word-fade";

/**
 * Component map for custom elements emitted by our rehype plugins.
 * Module-level so the reference stays stable across renders.
 */
const EXTRA_COMPONENTS = {
  [REDACTED_CREDENTIAL_TAG]: RedactedCredentialChip,
};

/** Returns true when `href` is a known `vellum://` attachment link. */
export function isVellumLink(href: string | undefined): boolean {
  return (
    href != null &&
    (href.startsWith("vellum://workspace/") ||
      href.startsWith("vellum://host/"))
  );
}

/**
 * Extends react-markdown's default URL sanitization to allow known
 * `vellum://workspace/` and `vellum://host/` attachment URIs. Other
 * `vellum://` shapes are rejected to limit protocol-handler attack surface.
 */
function vellumUrlTransform(url: string): string {
  if (
    url.startsWith("vellum://workspace/") ||
    url.startsWith("vellum://host/")
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}

function OAuthAwareLink({
  href,
  children,
}: Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) {
  const opensOAuthPopup = shouldOpenMarkdownLinkInOAuthPopup(href);

  return (
    <a
      href={href}
      target="_blank"
      rel={opensOAuthPopup ? undefined : "noopener noreferrer"}
      onClick={(event) => {
        if (openMarkdownOAuthLinkInPopup(href)) {
          event.preventDefault();
        }
      }}
      className="text-[var(--system-positive-strong)] underline hover:opacity-80"
    >
      {children}
    </a>
  );
}

const IMAGE_CLASSES =
  "my-2 max-w-full max-h-[400px] rounded-lg border border-[var(--border-default)] object-contain";

function ImageErrorFallback({ alt }: { alt: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
      Image failed to load{alt ? ` (${alt})` : ""}
    </span>
  );
}

function InlineImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <ImageErrorFallback alt={alt} />;
  }

  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className={IMAGE_CLASSES}
    />
  );
}

/**
 * Decode a URL basename for matching against attachment filenames, which are
 * stored decoded. Falls back to the raw value when the basename contains
 * malformed percent-encoding (a literal `%` not followed by two hex digits).
 */
function decodeBasename(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function WorkspaceInlineImage({
  src,
  alt,
  attachments,
  assistantId,
  onOpenPreview,
}: {
  src: string;
  alt: string;
  attachments: DisplayAttachment[] | undefined;
  assistantId: string | null | undefined;
  onOpenPreview?: (attachment: DisplayAttachment) => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const pathBasename = decodeBasename(src.split("/").pop() ?? "");
  const attachment = attachments?.find((a) => a.filename === pathBasename);

  useEffect(() => {
    if (
      !attachment ||
      !assistantId ||
      attachment.id.startsWith("rehydrated:")
    ) {
      return;
    }

    let revoked = false;
    (async () => {
      try {
        const { data, error } = await attachmentsByIdContentGet({
          path: { assistant_id: assistantId, id: attachment.id },
          parseAs: "blob",
          throwOnError: false,
        });
        if (revoked) {
          return;
        }
        if (error || !(data instanceof Blob)) {
          setFailed(true);
          return;
        }
        const url = URL.createObjectURL(data);
        setObjectUrl(url);
      } catch (err) {
        if (!revoked) {
          setFailed(true);
          captureError(err, {
            context: "WorkspaceInlineImage",
            bestEffort: true,
          });
        }
      }
    })();

    return () => {
      revoked = true;
      setObjectUrl((prev) => {
        if (prev) {
          URL.revokeObjectURL(prev);
        }
        return null;
      });
    };
  }, [attachment, assistantId]);

  if (failed || (!attachment && !objectUrl)) {
    return <ImageErrorFallback alt={alt || pathBasename} />;
  }

  if (!objectUrl) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
        Loading image…{alt ? ` (${alt})` : ""}
      </span>
    );
  }

  const image = <img src={objectUrl} alt={alt} className={IMAGE_CLASSES} />;

  if (!attachment || !onOpenPreview) {
    return image;
  }

  return (
    <button
      type="button"
      onClick={() => onOpenPreview(attachment)}
      className="cursor-zoom-in appearance-none border-0 bg-transparent p-0"
      aria-label={alt ? `Expand image: ${alt}` : "Expand image"}
    >
      {image}
    </button>
  );
}

export interface ChatMarkdownMessageProps extends Omit<
  MarkdownMessageProps,
  "linkComponent" | "imageComponent"
> {
  /**
   * Callback invoked when a `vellum://` link is clicked. Receives the full
   * href (e.g. `vellum://workspace/scratch/report.pdf`) and the visible
   * link text (e.g. `report.pdf`). When provided, `vellum://` links
   * render as download triggers instead of navigating.
   *
   * Pass a stable reference (useCallback) to avoid rebuilding the markdown
   * component tree on every render.
   */
  onVellumLinkClick?: (href: string, linkText: string) => void;
  /** Message attachments used to resolve `vellum://` image URLs. */
  attachments?: DisplayAttachment[];
  /** Active assistant ID for fetching attachment content from the daemon. */
  assistantId?: string | null;
  /**
   * Streamed-text reveal sweep (see `rehypeStreamWordFade`): each word is
   * wrapped in a fade span, and while `"revealing"` the words nearest the
   * reveal edge are graded toward transparent so the text appears through a
   * soft left-to-right gradient wipe. Pass `"caughtUp"` once the reveal has
   * drained the stream backlog so the tail lifts to full opacity (spans stay
   * mounted, ready for the next chunk). Only enable for the actively-growing
   * text of a streaming message — the spans cost DOM weight, so settled
   * content should render plain (`undefined`).
   */
  streamWordFade?: "revealing" | "caughtUp";
}

export const ChatMarkdownMessage = memo(function ChatMarkdownMessage({
  content,
  className,
  hardLineBreaks,
  onVellumLinkClick,
  attachments,
  assistantId,
  streamWordFade,
}: ChatMarkdownMessageProps) {
  const { openPreview, previewModal } = useAttachmentPreview(
    assistantId,
    attachments,
  );

  const linkComponent = useCallback(
    ({
      href,
      children,
    }: Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) => {
      if (onVellumLinkClick && isVellumLink(href)) {
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href) {
                const text = event.currentTarget.textContent ?? "";
                onVellumLinkClick(href, text);
              }
            }}
            className="text-[var(--system-positive-strong)] underline hover:opacity-80 cursor-pointer"
          >
            {children}
          </a>
        );
      }

      return <OAuthAwareLink href={href}>{children}</OAuthAwareLink>;
    },
    [onVellumLinkClick],
  );

  const extraRehypePlugins = useMemo(
    () => [
      // Upgrade redacted-credential sentinels into chip elements. Applied
      // unconditionally: sentinels only exist where the daemon persisted
      // them, and history must stay renderable regardless of flag state.
      rehypeRedactedCredential as import("unified").Pluggable,
      ...(streamWordFade
        ? [
            [
              rehypeStreamWordFade,
              { caughtUp: streamWordFade === "caughtUp" },
            ] as import("unified").Pluggable,
          ]
        : []),
    ],
    [streamWordFade],
  );

  const imageComponent: MarkdownImageComponent = useMemo(
    () =>
      ({ src, alt }: { src: string; alt: string }) => {
        if (isVellumLink(src)) {
          return (
            <WorkspaceInlineImage
              src={src}
              alt={alt}
              attachments={attachments}
              assistantId={assistantId}
              onOpenPreview={openPreview}
            />
          );
        }
        return <InlineImage src={src} alt={alt} />;
      },
    [attachments, assistantId, openPreview],
  );

  return (
    <>
      <MarkdownMessage
        content={content}
        className={className}
        hardLineBreaks={hardLineBreaks}
        linkComponent={linkComponent}
        imageComponent={imageComponent}
        urlTransform={vellumUrlTransform}
        extraRehypePlugins={extraRehypePlugins}
        extraComponents={EXTRA_COMPONENTS}
      />
      {previewModal}
    </>
  );
});
