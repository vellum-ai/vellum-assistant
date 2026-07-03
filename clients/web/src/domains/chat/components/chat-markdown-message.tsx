/**
 * Chat-domain MarkdownMessage that composes the design-library primitive
 * with OAuth-aware link handling and vellum:// file link support.
 */

import {
  type AnchorHTMLAttributes,
  memo,
  useCallback,
} from "react";
import {
  MarkdownMessage,
  type MarkdownMessageProps,
} from "@vellumai/design-library";
import { defaultUrlTransform } from "react-markdown";

import {
  openMarkdownOAuthLinkInPopup,
  shouldOpenMarkdownLinkInOAuthPopup,
} from "@/domains/chat/utils/oauth-popup-links";

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

export interface ChatMarkdownMessageProps extends Omit<MarkdownMessageProps, "linkComponent"> {
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
}

export const ChatMarkdownMessage = memo(function ChatMarkdownMessage({
  content,
  className,
  hardLineBreaks,
  onVellumLinkClick,
}: ChatMarkdownMessageProps) {
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

  return (
    <MarkdownMessage
      content={content}
      className={className}
      hardLineBreaks={hardLineBreaks}
      linkComponent={linkComponent}
      urlTransform={vellumUrlTransform}
    />
  );
});
