import { isElectron } from "@/runtime/is-electron";

export async function setMenuPlatformSession(has: boolean): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.menu.setPlatformSession(has);
}

/** One top-level native menu: a stable id plus the shell's own label. */
export interface MenuBarEntry {
  id: string;
  label: string;
}

/**
 * The native application menus, for the Windows in-title-bar menu bar.
 * Empty off Electron, on macOS (the system draws its menu bar), and on
 * shells that predate the menu popup bridge.
 */
export async function getMenuBarEntries(): Promise<MenuBarEntry[]> {
  if (!isElectron()) {
    return [];
  }
  return (await window.vellum?.menu.titles?.()) ?? [];
}

/**
 * Pop the native menu with the given id at (`x`, `y`), in CSS pixels
 * relative to the window. Resolves when the menu closes.
 */
export async function popupMenuBarMenu(
  id: string,
  x: number,
  y: number,
): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.menu.popup?.(id, x, y);
}
