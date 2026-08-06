"use client";

import { Sun, Moon, Monitor } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";

type Theme = "light" | "system" | "dark";
type StoredTheme = Theme | "velvet";

/* Theme state lives under BOTH `device:theme` (the assistant SPA's key, read
 * first by the pre-hydration bootstrap in src/app/layout.tsx) and
 * `vellum_theme` (the shared platform key), since both apps share the
 * www.vellum.ai origin. Dark mode is stamped as both the `.dark` class
 * (docs-theme.css) and the `data-theme` attribute (design-library tokens). */

const THEMES: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "system", icon: Monitor, label: "System" },
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
];

function isValidStoredTheme(value: string | null): value is StoredTheme {
  return (
    value === "light" ||
    value === "dark" ||
    value === "system" ||
    value === "velvet"
  );
}

function getStoredTheme(): StoredTheme {
  const stored =
    localStorage.getItem("device:theme") ?? localStorage.getItem("vellum_theme");
  return isValidStoredTheme(stored) ? stored : "system";
}

function isVisibleTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function applyThemeToDocument(theme: Theme) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const shouldBeDark = theme === "dark" || (theme === "system" && prefersDark);

  document.documentElement.classList.toggle("dark", shouldBeDark);
  document.documentElement.setAttribute(
    "data-theme",
    shouldBeDark ? "dark" : "light",
  );
}

function applyTheme(theme: Theme) {
  localStorage.setItem("vellum_theme", theme);
  localStorage.setItem("device:theme", theme);
  applyThemeToDocument(theme);

  window.dispatchEvent(new CustomEvent("vellumThemeChange", { detail: theme }));
}

function getSnapshot(): Theme {
  const stored = getStoredTheme();
  return isVisibleTheme(stored) ? stored : "dark";
}

function getServerSnapshot(): Theme {
  return "system";
}

function subscribe(callback: () => void): () => void {
  const handleThemeChange = () => callback();
  applyThemeToDocument(getSnapshot());

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleMediaChange = () => {
    if (getStoredTheme() === "system") {
      applyThemeToDocument("system");
    }
    callback();
  };

  window.addEventListener("vellumThemeChange", handleThemeChange);
  mediaQuery.addEventListener("change", handleMediaChange);
  return () => {
    window.removeEventListener("vellumThemeChange", handleThemeChange);
    mediaQuery.removeEventListener("change", handleMediaChange);
  };
}

export function DocsThemePicker() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const handleSelect = useCallback((next: Theme) => {
    applyTheme(next);
  }, []);

  const activeIndex = THEMES.findIndex((t) => t.value === theme);

  return (
    <div
      className="docs-theme-picker"
      role="radiogroup"
      aria-label="Color theme"
    >
      <div
        className="docs-theme-picker-indicator"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
      />
      {THEMES.map((t) => {
        const Icon = t.icon;
        const isActive = theme === t.value;
        return (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={t.label}
            title={t.label}
            className={`docs-theme-picker-option ${isActive ? "is-active" : ""}`}
            onClick={() => handleSelect(t.value)}
          >
            <Icon size={14} strokeWidth={isActive ? 2.2 : 1.8} />
          </button>
        );
      })}
    </div>
  );
}
