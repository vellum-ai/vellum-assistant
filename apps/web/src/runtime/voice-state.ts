import { isElectron, type VoiceModeState } from "@/runtime/is-electron";

export type { VoiceModeState };

/**
 * Per-capability wrapper for publishing the voice-mode state to the Electron
 * host. Matches the `runtime/status.ts` pattern: the renderer never touches
 * `window.vellum.*` directly — feature code calls this named function and the
 * cross-platform branch lives here.
 *
 * The renderer owns the voice-mode state machine (it holds the audio context
 * and the mic, so transitions fire locally without a main-process round
 * trip); main mirrors the state to drive the tray tooltip / menu header
 * while a voice conversation is active. Fire-and-forget — no acknowledgement.
 *
 * Safe to call from any host — no-op off Electron, and tolerant of an older
 * preload that predates the `voice` surface.
 */
export function publishVoiceModeState(state: VoiceModeState): void {
  if (!isElectron()) return;
  window.vellum?.voice?.setState(state);
}
