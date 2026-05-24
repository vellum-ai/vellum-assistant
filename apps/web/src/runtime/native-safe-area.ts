import { Capacitor } from "@capacitor/core";

function applyInsets(insets: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}) {
  const style = document.documentElement.style;
  style.setProperty("--safe-area-inset-top", `${insets.top}px`);
  style.setProperty("--safe-area-inset-right", `${insets.right}px`);
  style.setProperty("--safe-area-inset-bottom", `${insets.bottom}px`);
  style.setProperty("--safe-area-inset-left", `${insets.left}px`);
}

let initialized = false;

/**
 * Read device safe-area insets from the native layer via
 * `capacitor-plugin-safe-area` and expose them as CSS custom properties
 * on `<html>`. Must be awaited before first render so the layout never
 * paints with zero-inset padding.
 *
 * No-op outside the Capacitor shell — browser consumers fall through to
 * `env(safe-area-inset-*)` which works correctly in Safari / Chrome.
 *
 * Ported from vellum-assistant-platform's SafeAreaBridge.tsx.
 */
export async function initSafeAreaBridge(): Promise<void> {
  if (initialized) return;
  if (typeof window === "undefined" || !Capacitor.isNativePlatform()) return;
  initialized = true;

  try {
    const { SafeArea } = await import("capacitor-plugin-safe-area");

    try {
      const { insets } = await SafeArea.getSafeAreaInsets();
      applyInsets(insets);
    } catch {
      // Initial read failed — listener below may still deliver insets.
    }

    await SafeArea.addListener("safeAreaChanged", ({ insets: next }) => {
      applyInsets(next);
    });
  } catch {
    // Plugin unavailable — fall through to env() fallback.
  }
}
