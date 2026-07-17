import { getDeviceSetting, setDeviceSetting } from "@/utils/device-settings";

export type ThemePreference = "system" | "light" | "dark" | "velvet";

interface NormalizeThemeOptions {
  velvetEnabled: boolean;
  disabledVelvetFallback?: Exclude<ThemePreference, "velvet">;
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
  if (value === "velvet") {
    return velvetEnabled ? "velvet" : disabledVelvetFallback;
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
  const shouldBeDark =
    isVelvet || theme === "dark" || (theme === "system" && prefersDark);

  const root = document.documentElement;
  root.setAttribute(
    "data-theme",
    isVelvet ? "velvet" : shouldBeDark ? "dark" : "light",
  );
  root.classList.toggle("dark", shouldBeDark);
  root.classList.toggle("velvet", isVelvet);
}

export function getEffectiveThemePreference(
  theme: ThemePreference,
): "light" | "dark" | "velvet" {
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
