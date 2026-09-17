import { recordLifecycleDiagnostic } from "@/lib/diagnostics";

export function recordVoiceInputDiagnostic(
  event: string,
  details: Record<string, unknown>,
): void {
  try {
    const entry = { event, ...details };
    recordLifecycleDiagnostic("voice_input", entry);
    // Electron exports console info from every renderer, including companion calls.
    console.info(`[live-voice-input] ${JSON.stringify(entry)}`);
  } catch {
    // Diagnostics must not affect capture or playback.
  }
}
