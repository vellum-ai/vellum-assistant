import { cn } from "@/utils/misc";

interface PluginIconProps {
  external?: boolean;
  size?: "sm" | "md";
  className?: string;
}

const SIZE_CLASS = {
  sm: "h-7 w-7",
  md: "h-8 w-8 text-3xl",
} as const;

/**
 * Emoji-only icon for a plugin, mirroring `SkillIcon`'s container
 * dimensions for Plugins-tab / Skills-tab parity. Plugins have no
 * icon-image endpoint, so there is no remote-image branch. The glyph
 * follows the existing Plugins convention: 📦 for catalog (external),
 * 🧩 otherwise.
 */
export function PluginIcon({
  external = false,
  size = "sm",
  className,
}: PluginIconProps) {
  const glyph = external ? "\u{1F4E6}" : "\u{1F9E9}";

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        SIZE_CLASS[size],
        className,
      )}
    >
      {glyph}
    </span>
  );
}
