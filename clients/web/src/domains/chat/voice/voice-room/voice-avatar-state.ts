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
 * `reconnecting` retry signal) to the avatar's visual mode.
 *
 * - `connecting` while `reconnecting` → `"reconnecting"` (a dropped connection
 *   is being retried; visually distinct from the initial connect).
 * - `connecting` / `idle` / `ending` / `failed` → `"idle"` (no live activity to
 *   express — hosts typically unmount the room in the terminal states).
 * - `listening` → `"listening"`.
 * - `transcribing` / `thinking` → `"thinking"`.
 * - `speaking` → `"responding"`.
 */
export function toVoiceAvatarVisual(
  state: LiveVoiceSessionState,
  reconnecting: boolean,
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
      return "responding";
  }
}
