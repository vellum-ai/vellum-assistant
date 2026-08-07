import { ExternalLink } from "lucide-react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import { handleNativeAnchorClick } from "@/utils/native-anchor";

type ExternalAnchorProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "target" | "rel" | "onClick"
> & {
  href: string | undefined;
  children: ReactNode;
};

/** Anchor styling for a link that leaves the app. */
export const EXTERNAL_LINK_CLASS =
  "text-[var(--system-positive-strong)] underline hover:opacity-80";

/**
 * True for an `http(s)` destination, the links that leave the app for the web
 * and so earn the external-link glyph. Anything else a markdown link can carry
 * (`mailto:`, `tel:`, an in-app path) stays unadorned.
 */
export function isWebUrl(href: string | undefined): boolean {
  return /^https?:\/\//i.test(href ?? "");
}

/**
 * Trailing glyph marking a link as leaving the app.
 *
 * Sized and aligned to sit inside an ordinary (not inline-flex) anchor so long
 * link text still wraps; the glyph aligns via a small baseline shift instead.
 */
export function ExternalLinkGlyph() {
  return (
    <ExternalLink
      aria-hidden
      className="ml-0.5 inline h-3.5 w-3.5 shrink-0 align-[-0.125em]"
    />
  );
}

/**
 * Anchor to a destination outside the app.
 *
 * Every surface that renders a link out of the app needs the same three things
 * together: `target="_blank"`, the `noopener noreferrer` hardening, and the
 * native-shell click handler. The third is the one that gets forgotten, and its
 * absence is invisible on web and desktop; only the iOS/Android webviews break,
 * where a bare `target="_blank"` anchor silently does nothing. Route external
 * links through here so a surface cannot ship with two of the three.
 *
 * An `http(s)` destination also gets the external-link glyph, so the affordance
 * travels with the behaviour instead of being re-declared per surface.
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
      {isWebUrl(href) ? <ExternalLinkGlyph /> : null}
    </a>
  );
}
