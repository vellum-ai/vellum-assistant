/**
 * Small favicon with a graceful globe fallback.
 *
 * SPIKE — research-onboarding flow. Shared by the activity feed (search
 * result chips) and the results card (per-claim source "proof").
 */

import { useState } from "react";
import { Globe } from "lucide-react";

interface SourceFaviconProps {
  src?: string;
  /** For the title/alt + as a hint; not required. */
  domain?: string;
  className?: string;
}

export function SourceFavicon({ src, domain, className }: SourceFaviconProps) {
  const [failed, setFailed] = useState(false);
  const size = className ?? "size-4";
  if (!src || failed) {
    return (
      <span
        className={`flex ${size} items-center justify-center text-[var(--content-tertiary)]`}
      >
        <Globe className="size-3.5" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      title={domain}
      width={16}
      height={16}
      className={`${size} shrink-0 rounded-sm object-contain`}
      onError={() => setFailed(true)}
    />
  );
}
