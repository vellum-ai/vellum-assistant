
import { useEffect } from "react";

import { composeSvg } from "@/domains/avatar/svg-compositor.js";
import type { CharacterComponents, CharacterTraits } from "@/domains/avatar/types.js";

const FAVICON_SIZE = 32;
const DEFAULT_FAVICON = "/favicon.svg";

/**
 * Dynamically replaces the document favicon with the assistant's avatar.
 *
 * Uses the same priority as ChatAvatar:
 *   1. Character SVG (when components + explicit traits are available)
 *   2. Custom uploaded image (blob URL)
 *   3. No change (default Vellum favicon stays)
 *
 * On unmount or when no avatar is available, restores the default favicon.
 *
 * References:
 * - HTMLLinkElement.href: https://developer.mozilla.org/en-US/docs/Web/API/HTMLLinkElement
 * - SVG favicon support: https://caniuse.com/link-icon-svg
 * - Blob URL favicon support (all modern browsers): https://bugzilla.mozilla.org/show_bug.cgi?id=1184739
 */
export function useDynamicFavicon(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): void {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;

    let href: string | null = null;

    if (components && traits) {
      try {
        const svg = composeSvg(
          components,
          traits.bodyShape,
          traits.eyeStyle,
          traits.color,
          FAVICON_SIZE,
        );
        href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      } catch {
        // composeSvg throws on unknown IDs — fall through to image or default
      }
    }

    if (!href && customImageUrl) {
      href = customImageUrl;
    }

    if (href) {
      link.href = href;
    } else {
      link.href = DEFAULT_FAVICON;
    }

    return () => {
      link.href = DEFAULT_FAVICON;
    };
  }, [customImageUrl, components, traits]);
}
