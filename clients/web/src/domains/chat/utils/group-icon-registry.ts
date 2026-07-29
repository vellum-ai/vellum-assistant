/**
 * Custom-group icon registry: the single source of truth for the icons a
 * user can assign to a sidebar group (folder), keyed by the stable name the
 * daemon stores on the group row.
 *
 * Mirrors the channel-presentation registry pattern
 * (`@/utils/channel-presentation`): map a stored id to a module-level Lucide
 * component once, and every surface (expanded section header, collapsed rail
 * tile, icon picker) resolves through it. Keys are Lucide's kebab-case icon
 * names so they stay meaningful outside this client; an unknown or absent
 * name resolves to the default folder icon.
 */

import {
  Book,
  Briefcase,
  Camera,
  Code,
  Coffee,
  Flag,
  Folder,
  Gamepad2,
  Globe,
  GraduationCap,
  Heart,
  Home,
  Lightbulb,
  Music,
  Palette,
  Rocket,
  Star,
  Target,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

const GROUP_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  star: Star,
  heart: Heart,
  briefcase: Briefcase,
  home: Home,
  book: Book,
  code: Code,
  lightbulb: Lightbulb,
  rocket: Rocket,
  target: Target,
  flag: Flag,
  music: Music,
  camera: Camera,
  coffee: Coffee,
  "gamepad-2": Gamepad2,
  "graduation-cap": GraduationCap,
  palette: Palette,
  wrench: Wrench,
  zap: Zap,
  globe: Globe,
};

/** Fallback icon for groups with no (or an unrecognized) stored icon name. */
export const DEFAULT_GROUP_ICON: LucideIcon = Folder;

/**
 * Picker choices, in display order. Derived from the registry so the picker
 * can never offer a name the renderers don't resolve.
 */
export const GROUP_ICON_NAMES: string[] = Object.keys(GROUP_ICONS);

/**
 * Lucide icon component for a stored group icon name, or `undefined` when
 * the group has no explicit icon. Callers that need a glyph unconditionally
 * (the collapsed rail tile) fall back to {@link DEFAULT_GROUP_ICON}.
 */
export function getGroupIcon(
  iconName: string | null | undefined,
): LucideIcon | undefined {
  if (!iconName) {
    return undefined;
  }
  return GROUP_ICONS[iconName];
}
