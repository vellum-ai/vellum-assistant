import { useFallbackImageSource } from "@/hooks/use-fallback-image-source";
import { cn } from "@/utils/misc";

interface PluginIconProps {
  external?: boolean;
  /** Emoji glyph. Rendered as text only, never as an image source. */
  icon?: string;
  /** Platform-hosted catalog icon (https). Outranked by `iconSrc`. */
  iconUrl?: string;
  /** Legacy catalog icon used when `iconUrl` is unavailable in this bundle. */
  fallbackIconUrl?: string;
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
 * `iconSrc` (only when a gate passes and the plugin ships an icon) and
 * `iconUrl` (catalog rows only). Render precedence: the bundled `iconSrc`
 * image, then the `iconUrl` image, then the `icon` emoji, then the origin
 * glyph (📦 for catalog/external, 🧩 otherwise). `fallbackIconUrl` keeps a
 * stable catalog filename available when a versioned image is missing from an
 * older bundle.
 */
export function PluginIcon({
  external = false,
  icon,
  iconUrl,
  fallbackIconUrl,
  iconSrc,
  size = "sm",
  className,
}: PluginIconProps) {
  const { source: imageSrc, handleError } = useFallbackImageSource([
    iconSrc,
    iconUrl,
    fallbackIconUrl,
  ]);
  const glyph = icon || (external ? "\u{1F4E6}" : "\u{1F9E9}");
  const showImage = Boolean(imageSrc);

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
          src={imageSrc}
          alt=""
          aria-hidden
          loading="lazy"
          className="h-full w-full object-contain"
          onError={handleError}
        />
      ) : (
        glyph
      )}
    </span>
  );
}
