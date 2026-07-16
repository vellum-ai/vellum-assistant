import { Heart, Monitor, Moon, Sun } from "lucide-react";
import { useMemo } from "react";

import { cn, SegmentControl } from "@vellumai/design-library";

import {
  type ThemePreference,
} from "@/domains/settings/utils/theme-preferences";
import { useThemePreference } from "@/domains/settings/utils/use-theme-preference";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { isPointerCoarse } from "@/utils/pointer";

const BASE_THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  Icon: typeof Monitor;
}> = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

const VELVET_THEME_OPTION = {
  value: "velvet",
  label: "Velvet",
  Icon: Heart,
} satisfies {
  value: ThemePreference;
  label: string;
  Icon: typeof Monitor;
};

/**
 * Compact icon-only theme switcher for the sidebar preferences popover.
 * Mirrors the `AppearanceSection` in the Preferences modal — both share the
 * `useThemePreference` hook so they stay in sync via the `watchDeviceSetting`
 * listener.
 *
 * Tooltips are suppressed on coarse pointers: a tap moves focus to the segment
 * and the tooltip stays open until focus leaves, leaving phantom labels. Hover
 * devices keep the labels, which non-obvious options (Velvet's Heart) need.
 */
export function ThemeToggle({ className }: { className?: string } = {}) {
  const { theme, setThemePreference } = useThemePreference();
  const pointerCoarse = useMemo(() => isPointerCoarse(), []);

  const themeOptions = useClientFeatureFlagStore.use.velvet()
    ? [...BASE_THEME_OPTIONS, VELVET_THEME_OPTION]
    : BASE_THEME_OPTIONS;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-2",
        className,
      )}
    >
      <span
        className="text-body-small-default max-md:text-body-large-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Theme
      </span>
      <SegmentControl<ThemePreference>
        ariaLabel="Theme"
        value={theme}
        onChange={setThemePreference}
        iconOnly
        showTooltips={!pointerCoarse}
        items={themeOptions.map(({ value, label, Icon }) => ({
          value,
          label,
          // Mock glyph is ~14px (h-3.5 w-3.5 == 14px); bump to 16px on mobile.
          icon: <Icon className="h-3.5 w-3.5 max-md:h-4 max-md:w-4" />,
        }))}
      />
    </div>
  );
}
