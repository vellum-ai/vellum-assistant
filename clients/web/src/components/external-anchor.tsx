import { ExternalLink } from "lucide-react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

// Narrow paths, not the package root: this file sits under onboarding and
// auth screens whose tests mock `lucide-react` with only the icons they use,
// and the root barrel would load every component and every icon they import.
import {
  textLinkVariants,
  type TextLinkTone,
} from "@vellumai/design-library/components/text-link";
import { cn } from "@vellumai/design-library/utils/cn";

import { handleNativeAnchorClick } from "@/utils/native-anchor";

type ExternalAnchorProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "target" | "rel" | "onClick"
> & {
  href: string | undefined;
  /**
   * Optional so a self-closing element can be handed to `<Trans components>`,
   * which clones it and injects the translated text as its children.
   */
  children?: ReactNode;
  /**
   * Set to `false` to drop the trailing external-link glyph: for a link shaped
   * like a button, pill, card or row, and for one that draws its own icon.
   * Defaults to `true`.
   */
  glyph?: boolean;
  /**
   * Wear the design library's `TextLink` look in this tone. Leave it unset for
   * an anchor that is not a text link (a button, pill, card or row), which
   * styles itself through `className`.
   */
  tone?: TextLinkTone;
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
 * travels with the behaviour instead of being re-declared per surface. A
 * surface where a trailing glyph does not fit opts out with `glyph={false}` and
 * keeps the behaviour.
 *
 * The `href` stays on the element in every case, so "copy link address" and
 * middle-click keep working.
 */
export function ExternalAnchor({
  href,
  children,
  glyph = true,
  tone,
  className,
  ...rest
}: ExternalAnchorProps) {
  return (
    <a
      {...rest}
      className={
        tone === undefined
          ? className
          : cn(textLinkVariants({ tone }), className)
      }
      data-slot={tone === undefined ? undefined : "text-link"}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => handleNativeAnchorClick(event, href)}
    >
      {children}
      {glyph && isWebUrl(href) ? <ExternalLinkGlyph /> : null}
    </a>
  );
}
