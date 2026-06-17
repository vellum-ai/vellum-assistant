
import { useEffect, useState } from "react";

import { Typography, cn } from "@vellumai/design-library";

/**
 * Compact chip showing a site favicon and its title. Used in the
 * "Searching the web" loading UI to render a single search result.
 *
 * Matches Figma node 4922:104031 — a 14×14 favicon with 4px radius on a
 * `--surface-overlay` square, followed by a single-line title in
 * `body-small-default` (Inter Medium 12). The whole pill sits on
 * `--surface-base` with `--radius-pill` corners.
 *
 * When `faviconUrl` is missing OR the `<img>` errors, the favicon slot
 * shows a monogram fallback (the first uppercase letter of `domain` —
 * falling back to `title`).
 *
 * Chat-scoped: import directly via
 * `@/domains/chat/components/web-search/favicon-chip`.
 */
export interface FaviconChipProps {
  /**
   * Absolute URL to the site's favicon. When `undefined` or empty, no
   * `<img>` is rendered — the monogram fallback paints directly.
   */
  faviconUrl?: string;
  /** Visible chip label. Truncated with `max-w-[200px]`. */
  title: string;
  /**
   * Optional site domain used for the monogram fallback's letter. When
   * absent, the first character of `title` is used.
   */
  domain?: string;
  className?: string;
}

function monogramLetter(domain: string | undefined, title: string): string {
  const source = domain && domain.length > 0 ? domain : title;
  const first = source.charAt(0);
  return first ? first.toUpperCase() : "";
}

export function FaviconChip({
  faviconUrl,
  title,
  domain,
  className,
}: FaviconChipProps) {
  const [imageFailed, setImageFailed] = useState(false);
  // Reset the failed-image latch when the parent swaps to a different
  // `faviconUrl` on the same component instance (e.g. inside
  // `WebsiteCarousel`'s rotating slot). Without this the monogram
  // fallback sticks even when the new URL would have loaded fine.
  useEffect(() => {
    setImageFailed(false);
  }, [faviconUrl]);
  const hasFavicon = Boolean(faviconUrl) && !imageFailed;
  const letter = monogramLetter(domain, title);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-[10px] py-[6px]",
        "rounded-[var(--radius-pill)] bg-[var(--surface-base)] max-w-full",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex items-center justify-center",
          "h-[14px] w-[14px] rounded-[var(--radius-sm)] overflow-hidden shrink-0",
          "bg-[var(--surface-overlay)]",
        )}
      >
        {hasFavicon ? (
          <img
            src={faviconUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-contain"
            onError={() => setImageFailed(true)}
          />
        ) : (
          // typography: off-scale — 10px monogram inside 14px favicon slot
          <span className="text-[10px] font-medium leading-none text-[var(--content-default)]">
            {letter}
          </span>
        )}
      </span>
      <Typography
        variant="body-small-default"
        className="truncate max-w-[200px] text-[var(--content-default)]"
      >
        {title}
      </Typography>
    </span>
  );
}
