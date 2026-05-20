/**
 * Sounds feature types.
 *
 * Mirrors the macOS desktop app's `SoundEvent` / `SoundsConfig` / `SoundEventConfig`
 * so the web UI reads and writes the exact same `data/sounds/config.json`
 * payload stored in the assistant workspace.
 */

export const SUPPORTED_SOUND_EXTENSIONS = [
  "aiff",
  "wav",
  "mp3",
  "m4a",
  "caf",
] as const;

export const SOUND_EVENT_IDS = [
  "task_complete",
  "needs_input",
  "task_failed",
  "notification",
  "new_conversation",
  "message_sent",
  "character_poke",
  "random",
] as const;

export type SoundEventId = (typeof SOUND_EVENT_IDS)[number];

export const SOUND_EVENT_DISPLAY_NAMES: Record<SoundEventId, string> = {
  task_complete: "Task Complete",
  needs_input: "Needs Input",
  task_failed: "Task Failed",
  notification: "Notification",
  new_conversation: "New Conversation",
  message_sent: "Message Sent",
  character_poke: "Character Poke",
  random: "Random",
};

export interface SoundEventConfig {
  enabled: boolean;
  sounds: string[];
}

export interface SoundsConfig {
  globalEnabled: boolean;
  volume: number;
  events: Record<string, SoundEventConfig>;
}

export function defaultSoundsConfig(): SoundsConfig {
  const events: Record<string, SoundEventConfig> = {};
  for (const id of SOUND_EVENT_IDS) {
    events[id] = { enabled: false, sounds: [] };
  }
  return {
    globalEnabled: false,
    volume: 0.7,
    events,
  };
}

export function normaliseSoundsConfig(input: unknown): SoundsConfig {
  const base = defaultSoundsConfig();
  if (!input || typeof input !== "object") {
    return base;
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.globalEnabled === "boolean") {
    base.globalEnabled = obj.globalEnabled;
  }
  if (typeof obj.volume === "number" && Number.isFinite(obj.volume)) {
    base.volume = Math.max(0, Math.min(1, obj.volume));
  }

  const eventsInput = obj.events;
  if (eventsInput && typeof eventsInput === "object") {
    const eventsObj = eventsInput as Record<string, unknown>;
    for (const id of SOUND_EVENT_IDS) {
      const raw = eventsObj[id];
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const enabled = typeof rec.enabled === "boolean" ? rec.enabled : false;
      const sounds = Array.isArray(rec.sounds)
        ? rec.sounds.filter((s): s is string => typeof s === "string")
        : [];
      base.events[id] = { enabled, sounds };
    }
  }

  return base;
}

export function soundExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

export function hasSupportedExtension(filename: string): boolean {
  const ext = soundExtension(filename);
  return (SUPPORTED_SOUND_EXTENSIONS as readonly string[]).includes(ext);
}

export function validateSoundFilename(filename: string): boolean {
  if (!filename) return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  if (filename.includes("..")) return false;
  return hasSupportedExtension(filename);
}

export function displayLabelForFilename(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return filename;
  return filename.slice(0, idx);
}
