import { Heart, Monitor, Moon, Sun } from "lucide-react";

import { useThemePreference } from "@/hooks/use-theme-preference";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { type ThemePreference } from "@/utils/theme-preferences";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";

/**
 * Theme picker (System / Light / Dark, plus Velvet when the flag is on), shown
 * inline in the Preferences card on Settings → General. Not Electron-gated —
 * theme applies on every platform. Shares `useThemePreference` with the
 * sidebar `ThemeToggle`, so the two surfaces stay in sync.
 */
export function ThemePicker() {
  const velvet = useClientFeatureFlagStore.use.velvet();
  const { theme, setThemePreference } = useThemePreference();

  const themeItems = [
    {
      value: "system" as const,
      label: "System",
      icon: <Monitor className="h-4 w-4" />,
    },
    {
      value: "light" as const,
      label: "Light",
      icon: <Sun className="h-4 w-4" />,
    },
    {
      value: "dark" as const,
      label: "Dark",
      icon: <Moon className="h-4 w-4" />,
    },
    ...(velvet
      ? [
          {
            value: "velvet" as const,
            label: "Velvet",
            icon: <Heart className="h-4 w-4" />,
          },
        ]
      : []),
  ];

  return (
    <section>
      <h3 className="text-title-small text-[var(--content-emphasised)]">
        Theme
      </h3>
      <div className="mt-2 max-w-[360px]">
        <SegmentControl<ThemePreference>
          ariaLabel="Theme"
          value={theme}
          onChange={setThemePreference}
          items={themeItems}
        />
      </div>
    </section>
  );
}
