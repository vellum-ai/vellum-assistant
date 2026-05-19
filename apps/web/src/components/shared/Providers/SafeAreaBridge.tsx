
import type { PluginListenerHandle } from "@capacitor/core";
import { useEffect } from "react";

import { isNativePlatform } from "@/lib/native-auth.js";

/**
 * Reads the device's real safe-area insets from the Capacitor native layer
 * and exposes them to the web layer as CSS custom properties on `<html>`:
 *
 *   --safe-area-inset-top
 *   --safe-area-inset-right
 *   --safe-area-inset-bottom
 *   --safe-area-inset-left
 *
 * Why this is necessary: WebKit's built-in `env(safe-area-inset-*)` is
 * unreliable inside Capacitor's WKWebView. `CAPBridgeViewController` makes
 * the webview the VC's root view and (with `ios.contentInset: "never"`)
 * disables the scroll-view path that WebKit normally reads from, so
 * `env(safe-area-inset-*)` resolves to `0px` even on notched devices. See
 * WebKit bug #191872 (open since 2018) and Capacitor issue #2149. This is
 * the same approach Ionic Framework uses — their `core.scss` resolves
 * `var(--safe-area-inset-top, env(safe-area-inset-top))`, with the CSS
 * var as the primary source and env() only as a fallback.
 *
 * In a regular browser this component is a no-op (short-circuits on
 * `isNativePlatform()`), so browser consumers fall through to the
 * `env(...)` fallback — which works correctly in desktop/mobile Safari
 * where WKWebView's quirks don't apply.
 *
 * References:
 * - https://github.com/ionic-team/ionic-framework/blob/main/core/src/css/core.scss
 * - https://github.com/AlwaysLoveme/capacitor-plugin-safe-area
 * - https://bugs.webkit.org/show_bug.cgi?id=191872
 * - https://github.com/ionic-team/capacitor/issues/2149
 */
export function SafeAreaBridge(): null {
  useEffect(() => {
    if (!isNativePlatform()) return;

    let cancelled = false;
    let listener: PluginListenerHandle | undefined;

    const applyInsets = (insets: {
      top: number;
      right: number;
      bottom: number;
      left: number;
    }) => {
      const root = document.documentElement;
      root.style.setProperty("--safe-area-inset-top", `${insets.top}px`);
      root.style.setProperty("--safe-area-inset-right", `${insets.right}px`);
      root.style.setProperty("--safe-area-inset-bottom", `${insets.bottom}px`);
      root.style.setProperty("--safe-area-inset-left", `${insets.left}px`);
    };

    void (async () => {
      try {
        // Dynamic import so the plugin's web stub doesn't execute on SSR
        // or in the initial browser bundle (it's only used in Capacitor).
        const { SafeArea } = await import("capacitor-plugin-safe-area");
        if (cancelled) return;

        const { insets } = await SafeArea.getSafeAreaInsets();
        if (cancelled) return;
        applyInsets(insets);

        listener = await SafeArea.addListener(
          "safeAreaChanged",
          ({ insets: next }) => {
            applyInsets(next);
          },
        );
      } catch (err) {
        // Failing to read insets should not crash the app. Worst case we
        // fall back to the env() values baked into the CSS, which may be
        // 0 inside Capacitor — resulting in controls near the notch /
        // home indicator, matching the pre-fix state.
        console.warn("SafeAreaBridge: failed to read insets", err);
      }
    })();

    return () => {
      cancelled = true;
      // `remove` returns a Promise but we deliberately do not await it
      // in the cleanup fn (cleanups must be synchronous).
      void listener?.remove();
    };
  }, []);

  return null;
}
