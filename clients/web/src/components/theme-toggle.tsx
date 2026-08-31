import { Heart, Monitor, Moon, Sun } from "lucide-react";

import { cn, SegmentControl } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";
import { type ThemePreference } from "@/utils/theme-preferences";
import { useThemePreference } from "@/hooks/use-theme-preference";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * Compact icon-only theme switcher for the sidebar preferences popover.
 * Mirrors the `ThemePicker` on Settings → General. Both share the
 * `useThemePreference` hook so they stay in sync via the `watchDeviceSetting`
 * listener.
 *
 * Every segment carries a tooltip of its label, which non-obvious options
 * (Velvet's Heart) need. The design library mounts those only where the device
 * can hover, so a touch user is never left with a label a tap put up and
 * nothing takes down. The `aria-label` carries the same text either way.
 */
export function ThemeToggle({ className }: { className?: string } = {}) {
  const { t } = useTranslation();
  const { theme, setThemePreference } = useThemePreference();

  const baseThemeOptions: ReadonlyArray<{
    value: ThemePreference;
    label: string;
    Icon: typeof Monitor;
  }> = [
    { value: "system", label: t("themeToggle.system"), Icon: Monitor },
    { value: "light", label: t("themeToggle.light"), Icon: Sun },
    { value: "dark", label: t("themeToggle.dark"), Icon: Moon },
  ];

  const themeOptions = useClientFeatureFlagStore.use.velvet()
    ? [
        ...baseThemeOptions,
        {
          value: "velvet" as const,
          label: t("themeToggle.velvet"),
          Icon: Heart,
        },
      ]
    : baseThemeOptions;

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
        {t("themeToggle.label")}
      </span>
      <SegmentControl<ThemePreference>
        ariaLabel={t("themeToggle.label")}
        value={theme}
        onChange={setThemePreference}
        iconOnly
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
