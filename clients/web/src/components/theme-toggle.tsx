import { Heart, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { cn, SegmentControl } from "@vellumai/design-library";

import {
    applyThemePreference,
    readStoredThemePreference,
    type ThemePreference,
    writeStoredThemePreference,
} from "@/domains/settings/utils/theme-preferences";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { watchDeviceSetting } from "@/utils/device-settings";

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

export function ThemeToggle({ className }: { className?: string } = {}) {
  const velvet = useClientFeatureFlagStore.use.velvet();
  const [theme, setTheme] = useState<ThemePreference>(() =>
    readStoredThemePreference({ velvetEnabled: velvet }),
  );

  useEffect(() => {
    setTheme(readStoredThemePreference({ velvetEnabled: velvet }));
  }, [velvet]);

  useEffect(() => {
    return watchDeviceSetting("theme", () => {
      setTheme(readStoredThemePreference({ velvetEnabled: velvet }));
    });
  }, [velvet]);

  const handleChange = (next: ThemePreference) => {
    setTheme(next);
    writeStoredThemePreference(next);
    applyThemePreference(next);
  };

  const themeOptions = velvet
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
        onChange={handleChange}
        iconOnly
        // Icons (Monitor/Sun/Moon) are self-explanatory and each segment keeps
        // its `aria-label`; the per-segment tooltip otherwise hangs open on
        // touch focus, leaving a phantom "System"/"Light"/"Dark" label.
        showTooltips={false}
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
