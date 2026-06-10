/**
 * Runtime wrapper for the final transcription overlay bridge surface.
 *
 * Feature code imports these functions instead of touching
 * `window.vellum.transcriptionOverlay` directly. Off-Electron and on older
 * shells that predate the channel, calls degrade to no-ops.
 */

import {
  isElectron,
  type TranscriptionOverlayState,
} from "@/runtime/is-electron";

const DEFAULT_AUTO_DISMISS_MS = 6000;

export async function showTranscriptionOverlay(
  state:
    | TranscriptionOverlayState
    | {
        transcript: string;
        createdAt?: number;
        autoDismissMs?: number;
      },
): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.transcriptionOverlay?.show?.({
    transcript: state.transcript,
    createdAt: state.createdAt ?? Date.now(),
    autoDismissMs: state.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS,
  });
}

export async function dismissTranscriptionOverlay(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.transcriptionOverlay?.dismiss?.();
}

export function subscribeToTranscriptionOverlayState(
  callback: (state: TranscriptionOverlayState) => void,
): () => void {
  if (!isElectron() || !window.vellum?.transcriptionOverlay?.onState) {
    return () => undefined;
  }
  return window.vellum.transcriptionOverlay.onState(callback);
}

export async function getTranscriptionOverlayState(): Promise<TranscriptionOverlayState | null> {
  if (!isElectron() || !window.vellum?.transcriptionOverlay?.getState) {
    return null;
  }
  return window.vellum.transcriptionOverlay.getState();
}
