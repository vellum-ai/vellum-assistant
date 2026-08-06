import { isElectron } from "@/runtime/is-electron";
import type { CompanionCharacter } from "@vellumai/ipc-contract";

/**
 * Per-capability wrapper for the Electron host's app-icon surfaces (the macOS
 * Dock icon and the menu-bar Tray base image). Matches the `runtime/dock.ts`
 * pattern: the renderer never touches `window.vellum.*` directly — feature
 * code calls this named function and the cross-platform branch lives here.
 *
 * Publishes the assistant's avatar as raw PNG bytes. The renderer owns avatar
 * identity and rasterization because Electron's `nativeImage` only decodes
 * PNG/JPEG, not the trait-composited SVG; the main process owns per-surface
 * masking and the bundled-Vellum-mark fallback. Pass `null` when the
 * assistant has no custom avatar. Fire-and-forget — no acknowledgement.
 *
 * Safe to call from any host — no-op off Electron.
 */
export function setAssistantIcon(png: Uint8Array | null): void {
  if (!isElectron()) {
    return;
  }
  window.vellum?.icon?.setAvatar(png);
}

/**
 * Publish the traits the assistant's character is composed from, for surfaces
 * that render it live rather than showing the still {@link setAssistantIcon}
 * ships.
 *
 * The Dock and the Tray cannot animate, so pixels are all they can use. The
 * companion surface is a web renderer and can, so it composes the character
 * itself and the creature blinks and breathes there. Pass `null` for a custom
 * uploaded image or no avatar, which have no traits to compose from.
 *
 * Safe to call from any host: no-op off Electron and on a shell that predates
 * the channel.
 */
export function setAssistantCharacter(
  character: CompanionCharacter | null,
): void {
  if (!isElectron()) {
    return;
  }
  window.vellum?.icon?.setCharacter?.(character);
}
