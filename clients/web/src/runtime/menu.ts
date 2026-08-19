import { isElectron } from "@/runtime/is-electron";

export async function setMenuPlatformSession(has: boolean): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.menu.setPlatformSession(has);
}

/**
 * Titles of the native application menus, for the Windows in-title-bar menu
 * bar. Empty off Electron, on macOS (the system draws its menu bar), and on
 * shells that predate the menu popup bridge.
 */
export async function getMenuBarTitles(): Promise<string[]> {
  if (!isElectron()) {
    return [];
  }
  return (await window.vellum?.menu.titles?.()) ?? [];
}

/**
 * Pop the native menu named `title` at (`x`, `y`), in CSS pixels relative to
 * the window. Resolves when the menu closes.
 */
export async function popupMenuBarMenu(
  title: string,
  x: number,
  y: number,
): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.menu.popup?.(title, x, y);
}
