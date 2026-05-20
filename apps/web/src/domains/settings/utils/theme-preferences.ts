export type ThemePreference = "system" | "light" | "dark" | "velvet";

export const THEME_STORAGE_KEY = "vellum_theme";

interface NormalizeThemeOptions {
  velvetEnabled: boolean;
  disabledVelvetFallback?: Exclude<ThemePreference, "velvet">;
}

export function normalizeThemePreference(
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
  try {
    return normalizeThemePreference(
      window.localStorage.getItem(THEME_STORAGE_KEY),
      options,
    );
  } catch {
    return "system";
  }
}

export function writeStoredThemePreference(theme: ThemePreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme persistence is best-effort; still notify live listeners below.
  }
  window.dispatchEvent(new CustomEvent("vellumThemeChange", { detail: theme }));
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
