import { isElectron } from "@/runtime/is-electron";

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
  if (!isElectron()) return;
  window.vellum?.icon?.setAvatar(png);
}
