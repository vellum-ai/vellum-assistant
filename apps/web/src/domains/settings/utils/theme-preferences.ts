import { getDeviceSetting, setDeviceSetting } from "@/utils/device-settings";

export type ThemePreference = "system" | "light" | "dark" | "velvet" | "velvetist";

interface NormalizeThemeOptions {
  velvetEnabled: boolean;
  disabledVelvetFallback?: Exclude<ThemePreference, "velvet" | "velvetist">;
}

function normalizeThemePreference(
  value: string | null | undefined,
  {
    velvetEnabled,
    disabledVelvetFallback = "dark",
  }: NormalizeThemeOptions,
): ThemePreference {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  if (value === "velvet" || value === "velvetist") {
    return velvetEnabled ? (value as "velvet" | "velvetist") : disabledVelvetFallback;
  }
  return "system";
}

export function readStoredThemePreference(
  options: NormalizeThemeOptions,
): ThemePreference {
  if (typeof window === "undefined") return "system";
  const raw = getDeviceSetting("theme", "");
  return normalizeThemePreference(raw || null, options);
}

export function writeStoredThemePreference(theme: ThemePreference): void {
  setDeviceSetting("theme", theme);
}

export function applyThemePreference(theme: ThemePreference): void {
  if (typeof document === "undefined") return;

  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isVelvet = theme === "velvet";
  const isVelvetist = theme === "velvetist";
  const shouldBeDark =
    isVelvet || isVelvetist || theme === "dark" || (theme === "system" && prefersDark);

  const root = document.documentElement;
  root.setAttribute(
    "data-theme",
    isVelvetist ? "velvetist" : isVelvet ? "velvet" : shouldBeDark ? "dark" : "light",
  );
  root.classList.toggle("dark", shouldBeDark);
  root.classList.toggle("velvet", isVelvet);
  root.classList.toggle("velvetist", isVelvetist);
}

export function getEffectiveThemePreference(
  theme: ThemePreference,
): "light" | "dark" | "velvet" | "velvetist" {
  if (theme === "velvetist") return "velvetist";
  if (theme === "velvet") return "velvet";
  if (theme === "dark") return "dark";
  if (
    theme === "system" &&
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}
