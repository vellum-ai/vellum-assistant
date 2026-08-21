/**
 * Web sound playback manager.
 *
 * Mirrors the macOS `SoundManager` so the web client honours the same
 * globalEnabled, per-event enabled, and volume semantics. The pool of
 * sounds for an event plays in random order — when the pool is empty or
 * the referenced file cannot be loaded, a short synthesised "blip" is
 * played via the Web Audio API as a parity fallback for the macOS
 * default Tink.
 */

import { getAudioContextCtor } from "@/domains/chat/voice/audio-context";
import { fetchSoundFile } from "@/lib/sounds/api";
import { playBlip } from "@/lib/sounds/blip";
import {
  type SoundEventId,
  type SoundsConfig,
  validateSoundFilename,
} from "@/lib/sounds/types";

interface CachedSound {
  url: string;
}

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) {
    return 0.7;
  }
  if (v < 0) {
    return 0;
  }
  if (v > 1) {
    return 1;
  }
  return v;
}

class SoundManager {
  private assistantId: string | null = null;
  private config: SoundsConfig | null = null;
  private featureEnabled = false;
  private cache = new Map<string, CachedSound>();
  private pendingFetches = new Map<string, Promise<CachedSound | null>>();
  private audioContext: AudioContext | null = null;

  setAssistantId(assistantId: string | null): void {
    if (assistantId === this.assistantId) {
      return;
    }
    this.assistantId = assistantId;
    this.clearCache();
  }

  setConfig(config: SoundsConfig | null): void {
    this.config = config;
  }

  setFeatureEnabled(enabled: boolean): void {
    this.featureEnabled = enabled;
  }

  async play(event: SoundEventId): Promise<void> {
    if (!this.featureEnabled) {
      return;
    }
    const config = this.config;
    if (!config || !config.globalEnabled) {
      return;
    }

    const eventConfig = config.events[event];
    if (!eventConfig?.enabled) {
      return;
    }

    const volume = clampVolume(config.volume);
    const pool = eventConfig.sounds.filter(validateSoundFilename);

    if (pool.length === 0) {
      this.playFallbackBlip(volume);
      return;
    }

    const filename = pool[Math.floor(Math.random() * pool.length)];
    if (!filename) {
      this.playFallbackBlip(volume);
      return;
    }
    const ok = await this.playFile(filename, volume);
    if (!ok) {
      this.playFallbackBlip(volume);
    }
  }

  async previewSound(filename: string, volumeOverride?: number): Promise<void> {
    if (!this.featureEnabled) {
      return;
    }
    const volume = clampVolume(volumeOverride ?? this.config?.volume ?? 0.7);
    const ok = await this.playFile(filename, volume);
    if (!ok) {
      this.playFallbackBlip(volume);
    }
  }

  async previewFallbackBlip(volumeOverride?: number): Promise<void> {
    if (!this.featureEnabled) {
      return;
    }
    const volume = clampVolume(volumeOverride ?? this.config?.volume ?? 0.7);
    this.playFallbackBlip(volume);
  }

  clearCache(): void {
    for (const cached of this.cache.values()) {
      URL.revokeObjectURL(cached.url);
    }
    this.cache.clear();
    this.pendingFetches.clear();
  }

  private async playFile(filename: string, volume: number): Promise<boolean> {
    if (!validateSoundFilename(filename)) {
      return false;
    }
    const cached = await this.getOrFetch(filename);
    if (!cached) {
      return false;
    }
    try {
      const audio = new Audio(cached.url);
      audio.volume = volume;
      await audio.play();
      return true;
    } catch {
      return false;
    }
  }

  private async getOrFetch(filename: string): Promise<CachedSound | null> {
    const hit = this.cache.get(filename);
    if (hit) {
      return hit;
    }

    const inFlight = this.pendingFetches.get(filename);
    if (inFlight) {
      return inFlight;
    }

    const assistantId = this.assistantId;
    if (!assistantId) {
      return null;
    }

    const promise = (async () => {
      try {
        const blob = await fetchSoundFile(assistantId, filename);
        if (!blob) {
          return null;
        }
        const url = URL.createObjectURL(blob);
        const entry: CachedSound = { url };
        this.cache.set(filename, entry);
        return entry;
      } finally {
        this.pendingFetches.delete(filename);
      }
    })();
    this.pendingFetches.set(filename, promise);
    return promise;
  }

  private playFallbackBlip(volume: number): void {
    try {
      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) {
        return;
      }
      this.audioContext ??= new AudioContextCtor();
      playBlip(this.audioContext, volume);
    } catch {
      // Autoplay can be blocked until the user interacts with the page.
    }
  }
}

let singleton: SoundManager | null = null;

export function getSoundManager(): SoundManager {
  if (!singleton) {
    singleton = new SoundManager();
  }
  return singleton;
}
