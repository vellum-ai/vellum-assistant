import { useEffect, useState } from "react";

import { cn } from "@/utils/misc";

interface PluginIconProps {
  external?: boolean;
  icon?: string;
  iconSrc?: string;
  size?: "sm" | "md";
  className?: string;
}

const SIZE_CLASS = {
  sm: "h-7 w-7",
  md: "h-8 w-8 text-3xl",
} as const;

/**
 * Icon for a plugin, mirroring `SkillIcon`'s container dimensions for
 * Plugins-tab / Skills-tab parity. A dumb renderer: the caller decides
 * `iconSrc` (only when a gate passes and the plugin ships an icon). Render
 * precedence — a bundled `iconSrc` image, then the author-provided `icon`
 * emoji, then the origin glyph (📦 for catalog/external, 🧩 otherwise). A
 * failed image load falls through to the emoji/glyph chain.
 */
export function PluginIcon({
  external = false,
  icon,
  iconSrc,
  size = "sm",
  className,
}: PluginIconProps) {
  const [imageFailed, setImageFailed] = useState(false);
  // Retry the image when the source changes (e.g. a new icon URL or a
  // cache-busting version) so a past failure doesn't pin a reused instance
  // to the fallback.
  useEffect(() => {
    setImageFailed(false);
  }, [iconSrc]);
  const glyph = icon || (external ? "\u{1F4E6}" : "\u{1F9E9}");
  const showImage = Boolean(iconSrc) && !imageFailed;

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        SIZE_CLASS[size],
        className,
      )}
    >
      {showImage ? (
        <img
          src={iconSrc}
          alt=""
          aria-hidden
          loading="lazy"
          className="h-full w-full object-contain"
          onError={() => setImageFailed(true)}
        />
      ) : (
        glyph
      )}
    </span>
  );
}
