/**
 * Runtime wrapper for the standalone Electron command palette window.
 *
 * New Electron shells expose `window.vellum.commandPalette`; web/iOS and
 * older Electron shells do not. `openCommandPaletteWindow` returns whether
 * the host handled the request so callers can fall back to the in-page
 * palette without probing `window.vellum` themselves.
 */

import { isElectron, type VellumCommand } from "@/runtime/is-electron";

export async function openCommandPaletteWindow(): Promise<boolean> {
  if (!isElectron()) {
    return false;
  }
  const open = window.vellum?.commandPalette?.open;
  if (!open) {
    return false;
  }
  await open();
  return true;
}

export async function dismissCommandPaletteWindow(): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.commandPalette?.dismiss();
}

export async function selectCommandPaletteCommand(
  command: VellumCommand,
): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.commandPalette?.select(command);
}
