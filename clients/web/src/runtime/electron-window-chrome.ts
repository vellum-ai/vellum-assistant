/**
 * The Electron desktop window's chrome, as the renderer owns it: the band the
 * app's own title bar occupies, and the native window controls drawn into it.
 */
import type { TitleBarOverlayColors } from "@vellumai/ipc-contract";

import { detectElectronHostOS } from "@/runtime/platform-detection";
import { isPopoutWindow } from "@/runtime/popout-window";

export const WINDOWS_TITLE_BAR_CONTROL_CLEARANCE_PX = 150;

const THEME_ATTRIBUTE = "data-theme";

/**
 * The theme tokens the caption buttons are painted from: the surface every
 * title bar is drawn on, and the text color sitting on it. Reading the tokens
 * rather than a per-theme table keeps the buttons on whatever the light, dark,
 * and velvet themes define, with no second copy of those colors to drift.
 */
function readOverlayColors(): TitleBarOverlayColors | null {
  // The attribute is stamped by `applyThemePreference()`. Until it lands the
  // effective theme is unknown, and reporting the `:root` fallback would flash
  // a light overlay onto a dark window.
  if (!document.documentElement.hasAttribute(THEME_ATTRIBUTE)) {
    return null;
  }
  const styles = getComputedStyle(document.documentElement);
  const color = styles.getPropertyValue("--surface-base").trim();
  const symbolColor = styles.getPropertyValue("--content-default").trim();
  if (!color || !symbolColor) {
    return null;
  }
  return { color, symbolColor };
}

/**
 * Keep the Windows title-bar overlay (the native minimize / maximize / close
 * buttons) in the active theme's colors, for the life of the renderer.
 *
 * The overlay is chrome the OS draws over the webview, so no stylesheet reaches
 * it: left alone it renders on the system caption colors, a light strip in the
 * corner of a dark title bar. Publishing the theme's colors to main, which
 * applies them with `BrowserWindow.setTitleBarOverlay`, is how the buttons join
 * the title bar they sit in.
 *
 * No-op off the Windows desktop client: macOS draws traffic lights the system
 * themes itself, and web and Capacitor hosts have no window chrome. Pop-out
 * windows keep their native title bar and have no overlay to color.
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

  const publish = () => {
    const colors = readOverlayColors();
    if (!colors) {
      return;
    }
    void window.vellum?.mainWindow.setTitleBarOverlay?.(colors);
  };

  publish();
  const observer = new MutationObserver(publish);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });
  return () => {
    observer.disconnect();
  };
}
