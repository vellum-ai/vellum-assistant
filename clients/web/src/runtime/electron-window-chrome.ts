/**
 * The Electron desktop window's chrome, as the renderer owns it: the band the
 * app's own title bar occupies, and the native window controls drawn into it.
 */
import type { TitleBarOverlayTheme } from "@vellumai/ipc-contract";

import { detectElectronHostOS } from "@/runtime/platform-detection";
import { isPopoutWindow } from "@/runtime/popout-window";

export const WINDOWS_TITLE_BAR_CONTROL_CLEARANCE_PX = 150;

/**
 * The root attributes an effective theme arrives through: `data-theme` and the
 * `dark` class for the light / dark / velvet base (`applyThemePreference()`),
 * and inline custom properties for a workspace theme's overrides layered on top
 * of it (`applyWorkspaceThemeTokens()`).
 */
const THEME_ATTRIBUTES = ["data-theme", "class", "style"];

/**
 * The theme tokens the caption buttons are painted from: the surface every
 * title bar is drawn on, and the text color sitting on it. Reading the tokens
 * rather than a per-theme table keeps the buttons on whatever the light, dark,
 * and velvet themes define, with no second copy of those colors to drift.
 */
function readOverlayTheme(): TitleBarOverlayTheme | null {
  const root = document.documentElement;
  // The attribute is stamped by `applyThemePreference()`. Until it lands the
  // effective theme is unknown, and reporting the `:root` fallback would flash
  // a light overlay onto a dark window.
  if (!root.hasAttribute("data-theme")) {
    return null;
  }
  const styles = getComputedStyle(root);
  const color = styles.getPropertyValue("--surface-base").trim();
  const symbolColor = styles.getPropertyValue("--content-default").trim();
  if (!color || !symbolColor) {
    return null;
  }
  // Both dark and velvet carry the `dark` class, which is how the rest of the
  // app decides which of the two schemes it is painting.
  return {
    color,
    symbolColor,
    colorScheme: root.classList.contains("dark") ? "dark" : "light",
  };
}

/**
 * Keep the Windows title-bar overlay (the native minimize / maximize / close
 * buttons) in the active theme's colors, for the life of the renderer.
 *
 * The overlay is chrome the OS draws over the webview, so no stylesheet reaches
 * it: left alone it renders on the system caption colors, a light strip in the
 * corner of a dark title bar. Publishing the theme's colors to main, which
 * applies them with `BrowserWindow.setTitleBarOverlay`, is how the buttons join
 * the title bar they sit in. The scheme those colors come from goes with them,
 * because Chromium washes the buttons on hover from the native scheme rather
 * than from the overlay's color.
 *
 * No-op off the Windows desktop client: macOS draws traffic lights the system
 * themes itself, and web and Capacitor hosts have no window chrome. Pop-out
 * windows keep their native title bar and have no overlay to color. Colors
 * published from any other auxiliary window are dropped by main, which paints
 * the overlay only for the window that reported them.
 *
 * Returns a function that stops watching for theme changes.
 *
 * @see https://www.electronjs.org/docs/latest/tutorial/custom-title-bar
 */
export function initWindowsTitleBarOverlay(): () => void {
  if (detectElectronHostOS() !== "windows") {
    return () => undefined;
  }
  if (isPopoutWindow(window.location.search)) {
    return () => undefined;
  }

  let published: TitleBarOverlayTheme | null = null;
  const publish = () => {
    const theme = readOverlayTheme();
    if (!theme) {
      return;
    }
    // The root's `style` carries more than theme tokens, so most mutations
    // resolve to the theme already painted.
    if (
      theme.color === published?.color &&
      theme.symbolColor === published?.symbolColor &&
      theme.colorScheme === published?.colorScheme
    ) {
      return;
    }
    published = theme;
    void window.vellum?.mainWindow.setTitleBarOverlay?.(theme);
  };

  publish();
  const observer = new MutationObserver(publish);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: THEME_ATTRIBUTES,
  });
  return () => {
    observer.disconnect();
  };
}
