/**
 * Chrome-less 14×14 site favicon with a monogram fallback.
 *
 * Renders the bare favicon `<img>` (no pill / surface chrome) so callers that
 * already supply their own container — e.g. the settled web-search header,
 * which sits a favicon immediately left of the page title — can drop it inline
 * without inheriting the {@link FaviconChip} pill geometry. On a missing or
 * failed favicon it falls back to the uppercased first letter of `domain`
 * (then `title`) as a monogram, mirroring the favicon+fallback pattern used by
 * `tool-step-pill`'s `PillFavicon` and `web-search-step-row`'s
 * `OverflowSourceLink`.
 */

import { useEffect, useState } from "react";

import { cn } from "@/utils/misc";

interface SiteFaviconProps {
  /** Site favicon URL; falls back to a monogram on absence / load error. */
  faviconUrl?: string;
  /** Site domain — supplies the monogram fallback letter. */
  domain?: string;
  /** Page title — monogram source when `domain` is empty. */
  title: string;
  /** Extra classes merged onto the outer span. */
  className?: string;
}

export function SiteFavicon({
  faviconUrl,
  domain,
  title,
  className,
}: SiteFaviconProps) {
  const [imageFailed, setImageFailed] = useState(false);
  // Reset the failed flag when the URL changes so a swapped favicon re-attempts
  // loading rather than staying stuck on the monogram.
  useEffect(() => {
    setImageFailed(false);
  }, [faviconUrl]);

  const hasFavicon = Boolean(faviconUrl) && !imageFailed;
  const source = domain && domain.length > 0 ? domain : title;
  const letter = source.charAt(0).toUpperCase();

  return (
    <span
      aria-hidden="true"
      data-testid="site-favicon"
      className={cn(
        "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)]",
        className,
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
        // typography: off-scale — 10px monogram inside the 14px favicon slot
        <span className="text-[10px] font-medium leading-none text-[var(--content-tertiary)]">
          {letter}
        </span>
      )}
    </span>
  );
}
