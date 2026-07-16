import { Heart, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { DetailCard } from "@/components/detail-card";
import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/domains/settings/utils/theme-preferences";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { watchDeviceSetting } from "@/utils/device-settings";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";

/**
 * Theme picker (System / Light / Dark, plus Velvet when the flag is on),
 * rendered as its own card on Settings → General so the theme control is
 * visible directly rather than hidden behind the Preferences modal. Unlike the
 * per-device preferences in that modal it is not Electron-gated — theme applies
 * on every platform.
 */
export function AppearanceCard() {
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

  useEffect(() => {
    applyThemePreference(theme);
  }, [theme]);

  const handleThemeChange = (newTheme: ThemePreference) => {
    setTheme(newTheme);
    writeStoredThemePreference(newTheme);
    applyThemePreference(newTheme);
  };

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
    <DetailCard title="Appearance">
      <div className="max-w-[360px]">
        <SegmentControl<ThemePreference>
          ariaLabel="Theme"
          value={theme}
          onChange={handleThemeChange}
          items={themeItems}
        />
      </div>
    </DetailCard>
  );
}
