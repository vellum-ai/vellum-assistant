import type { AnchorHTMLAttributes, ReactNode } from "react";

import { handleNativeAnchorClick } from "@/utils/native-anchor";

type ExternalAnchorProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "target" | "rel" | "onClick"
> & {
  href: string | undefined;
  children: ReactNode;
};

/**
 * True for an `http(s)` destination, the links that leave the app for the web
 * and so earn the external-link glyph. Anything else a markdown link can carry
 * (`mailto:`, `tel:`, an in-app path) stays unadorned.
 */
export function isWebUrl(href: string | undefined): boolean {
  return /^https?:\/\//i.test(href ?? "");
}

/**
 * Anchor to a destination outside the app.
 *
 * Every surface that renders a link out of the app needs the same three things
 * together: `target="_blank"`, the `noopener noreferrer` hardening, and the
 * native-shell click handler. The third is the one that gets forgotten, and its
 * absence is invisible on web and desktop — only the iOS/Android webviews
 * break, where a bare `target="_blank"` anchor silently does nothing. Route
 * external links through here so a surface cannot ship with two of the three.
 *
 * The `href` stays on the element in every case, so "copy link address" and
 * middle-click keep working.
 */
export function ExternalAnchor({
  href,
  children,
  ...rest
}: ExternalAnchorProps) {
  return (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => handleNativeAnchorClick(event, href)}
    >
      {children}
    </a>
  );
}
