import { cn } from "@/utils/misc";

interface PluginIconProps {
  external?: boolean;
  emoji?: string;
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
 * icon-image endpoint, so there is no remote-image branch. The default
 * follows the existing Plugins convention: 📦 for catalog (external),
 * 🧩 otherwise; a passed `emoji` overrides the default.
 */
export function PluginIcon({
  external = false,
  emoji,
  size = "sm",
  className,
}: PluginIconProps) {
  const glyph = emoji ?? (external ? "\u{1F4E6}" : "\u{1F9E9}");

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
