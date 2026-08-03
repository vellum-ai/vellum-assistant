/**
 * The theme currently applied to the document, read straight off the
 * `data-theme` attribute `applyThemePreference()` stamps on
 * `document.documentElement`.
 *
 * Reading the attribute rather than the stored preference means the hook
 * reflects the *effective* theme: a `"system"` preference resolving to dark,
 * an OS-level change, and an explicit toggle all surface identically.
 *
 * @see {@link @/utils/theme-preferences} for the writer.
 */

import { useSyncExternalStore } from "react";

const THEME_ATTRIBUTE = "data-theme";

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });
  return () => observer.disconnect();
}

function getSnapshot(): string {
  if (typeof document === "undefined") {
    return "light";
  }
  return document.documentElement.getAttribute(THEME_ATTRIBUTE) ?? "light";
}

export function useDocumentTheme(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => "light");
}
