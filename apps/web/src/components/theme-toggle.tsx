import { Heart, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { cn, SegmentControl } from "@vellum/design-library";

import { useFeatureFlagStore } from "@/lib/feature-flags/feature-flag-store.js";
import {
  applyThemePreference,
  normalizeThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/domains/settings/utils/theme-preferences.js";

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
  const velvet = useFeatureFlagStore.use.velvet();
  const [theme, setTheme] = useState<ThemePreference>(() =>
    readStoredThemePreference({ velvetEnabled: velvet }),
  );

  useEffect(() => {
    const handleExternalThemeChange = (event: CustomEvent<string>) => {
      setTheme(
        normalizeThemePreference(event.detail, { velvetEnabled: velvet }),
      );
    };
    window.addEventListener(
      "vellumThemeChange",
      handleExternalThemeChange as EventListener,
    );
    return () =>
      window.removeEventListener(
        "vellumThemeChange",
        handleExternalThemeChange as EventListener,
      );
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
        "flex items-center justify-between gap-3 px-4 py-2 max-md:py-3",
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
        items={themeOptions.map(({ value, label, Icon }) => ({
          value,
          label,
          icon: <Icon className="h-3.5 w-3.5 max-md:h-4 max-md:w-4" />,
        }))}
      />
    </div>
  );
}
