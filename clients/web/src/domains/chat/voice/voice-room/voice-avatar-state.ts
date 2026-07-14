import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";

/**
 * Visual mode the {@link VoiceAvatar} renders, distilled from the richer
 * live-voice session phase. Several session phases collapse to one visual
 * (e.g. `transcribing` and `thinking` both read as `"thinking"`), and the
 * orthogonal `reconnecting` signal promotes `connecting` to `"reconnecting"`.
 */
export type VoiceAvatarVisual =
  | "idle"
  | "listening"
  | "thinking"
  | "responding"
  | "reconnecting";

/**
 * Pure mapping from a live-voice session phase (plus the orthogonal
 * `reconnecting` retry signal and whether assistant audio is actually flowing)
 * to the avatar's visual mode.
 *
 * - `connecting` while `reconnecting` → `"reconnecting"` (a dropped connection
 *   is being retried; visually distinct from the initial connect).
 * - `connecting` / `idle` / `ending` / `failed` → `"idle"` (no live activity to
 *   express — hosts typically unmount the room in the terminal states).
 * - `listening` → `"listening"`.
 * - `transcribing` / `thinking` → `"thinking"`.
 * - `speaking` → `"responding"` while audio is flowing, else `"thinking"`.
 *
 * The `speaking` phase is a pure mirror of the server's turn framing — it is set
 * on the first `tts_audio` frame and cleared only on `tts_done` (turn end) or a
 * barge-in. A turn that speaks a short ack and then runs a tool (e.g. the
 * app-builder skill) stays `speaking` for the whole silent tool run. Gating on
 * `assistantAudioActive` (audio actually queued/playing, tracked by the
 * controller from the player) collapses that silent stretch back to `thinking`,
 * so the room stops claiming the assistant is talking mid-turn. Defaults to
 * `true` — a non-`speaking` phase never reads it, and callers without the signal
 * keep the plain `speaking → responding` behavior. (JARVIS-1279)
 */
export function toVoiceAvatarVisual(
  state: LiveVoiceSessionState,
  reconnecting: boolean,
  assistantAudioActive = true,
): VoiceAvatarVisual {
  switch (state) {
    case "connecting":
      return reconnecting ? "reconnecting" : "idle";
    case "idle":
    case "ending":
    case "failed":
      return "idle";
    case "listening":
      return "listening";
    case "transcribing":
    case "thinking":
      return "thinking";
    case "speaking":
      return assistantAudioActive ? "responding" : "thinking";
  }
}
