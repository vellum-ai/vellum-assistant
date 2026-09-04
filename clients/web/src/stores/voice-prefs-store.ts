/**
 * Zustand store for live-voice mode preferences.
 *
 * Owns whether the user- and assistant-side transcripts are shown in
 * the voice UI, plus a one-time flag recording that the user has seen
 * the first-run voice experience. Voice-mode components read these via
 * the generated selector hooks (`useVoicePrefsStore.use.*`).
 *
 * **Storage model:**
 *
 * - The persist middleware serialises the whole voice-prefs slice into
 *   a single localStorage key, `vellum:voice-prefs`.
 * - Cross-tab updates: the persist middleware doesn't sync across tabs
 *   on its own. We listen for `storage` events on `vellum:voice-prefs`
 *   and call `persist.rehydrate()` to pull in the other tab's write,
 *   except for a payload stamped past this build's version, which it
 *   leaves for the build that wrote it. See
 *   {@link isFutureVoicePrefsPayload}.
 *
 * Reference:
 * - {@link https://zustand.docs.pmnd.rs/}
 * - {@link https://zustand.docs.pmnd.rs/integrations/persisting-store-data}
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

/**
 * "Interrupt sensitivity" — how easily the user's speech cuts off the
 * assistant mid-reply. Higher sensitivity interrupts sooner (less sustained
 * speech required); lower is more forgiving of coughs, filler words, and the
 * assistant's own TTS bleeding through imperfect echo cancellation. Maps to the
 * daemon's `bargeInMinSpeechMs` — note the mapping is *inverse* (more sensitive
 * ⇒ fewer ms). See {@link INTERRUPT_SENSITIVITY_TO_MS}.
 */
export type InterruptSensitivity = "low" | "medium" | "high";

/** Default "pause before reply" (ms) — mirrors the daemon `liveVoice.vad.silenceThresholdMs` default. */
export const DEFAULT_PAUSE_BEFORE_REPLY_MS = 1200;
/** Bounds for the "pause before reply" slider (ms); stays inside the daemon's accepted range. */
export const MIN_PAUSE_BEFORE_REPLY_MS = 500;
export const MAX_PAUSE_BEFORE_REPLY_MS = 3000;

/** Default interrupt sensitivity — the ms value mirrors the daemon `bargeInMinSpeechMs` default (250). */
export const DEFAULT_INTERRUPT_SENSITIVITY: InterruptSensitivity = "medium";

/**
 * Interrupt-sensitivity level → sustained-speech ms sent as `bargeInMinSpeechMs`.
 * Inverse: a *higher* sensitivity needs *less* speech to barge in.
 */
export const INTERRUPT_SENSITIVITY_TO_MS: Record<InterruptSensitivity, number> =
  {
    high: 100,
    medium: 250,
    low: 600,
  };

/** Resolve an interrupt-sensitivity level to the `bargeInMinSpeechMs` it sends. */
export function interruptSensitivityToMs(level: InterruptSensitivity): number {
  return INTERRUPT_SENSITIVITY_TO_MS[level];
}

/**
 * Clamp a "pause before reply" value to the supported range and round to a
 * whole millisecond, so neither the slider nor a stale persisted value can send
 * an out-of-range `silenceThresholdMs` the daemon would reject.
 */
export function clampPauseBeforeReplyMs(ms: number): number {
  if (!Number.isFinite(ms)) {
    return DEFAULT_PAUSE_BEFORE_REPLY_MS;
  }
  return Math.round(
    Math.min(
      MAX_PAUSE_BEFORE_REPLY_MS,
      Math.max(MIN_PAUSE_BEFORE_REPLY_MS, ms),
    ),
  );
}

/**
 * Camera flash for a photo taken from the voice room: `auto` fires it when the
 * scene is dark enough, `on` fires it always, `off` never.
 *
 * Capture flash only. A torch (the lamp held on continuously) is deliberately
 * not one of these: iOS models it as a separate mode that the photo flash then
 * has to turn back off, so offering both in one control gives the user two ways
 * to light a scene that disagree with each other.
 */
export type FlashMode = "off" | "auto" | "on";

export interface VoicePrefsState {
  /** Whether the user-side transcript is shown in the voice UI. */
  showUserTranscript: boolean;
  /** Whether the assistant-side transcript is shown in the voice UI. */
  showAssistantTranscript: boolean;
  /** True once the user has seen the first-run voice experience. */
  firstRunSeen: boolean;
  /**
   * Trailing-silence duration (ms) after the user stops speaking before the
   * assistant replies — the "pause before reply" setting. Sent as the session's
   * `silenceThresholdMs`. A longer pause tolerates mid-thought pauses without
   * the assistant jumping in.
   *
   * `null` means the user hasn't set a preference — the session omits the
   * override so the daemon's configured `liveVoice.vad.silenceThresholdMs`
   * governs (never silently clobbering a self-hosted workspace's config). The
   * UI still shows {@link DEFAULT_PAUSE_BEFORE_REPLY_MS} as the resting value.
   */
  pauseBeforeReplyMs: number | null;
  /**
   * How easily the user can interrupt the assistant mid-reply. `null` means no
   * preference set — the daemon's configured `bargeInMinSpeechMs` governs (see
   * {@link pauseBeforeReplyMs}); the UI shows
   * {@link DEFAULT_INTERRUPT_SENSITIVITY} as the resting value.
   */
  interruptSensitivity: InterruptSensitivity | null;
  /**
   * The flash mode the user picked for the voice room's camera.
   *
   * Their CHOICE, never what the hardware could do with it. Flipping to a
   * front camera with no flash hides the control instead of writing `off` here,
   * so flipping back restores the mode they set rather than one the device
   * silently picked for them.
   */
  flashMode: FlashMode;
  /**
   * Whether the viewfinder draws the accented thumbnail of the newest frame
   * Live gave the call.
   *
   * A view preference, not a capture one: sampling, sending and the
   * transcript record of every kept frame are the same either way. Off by
   * default, so the viewfinder is only the scene the user is aiming at; the
   * camera panel is where a call turns the one visible keep signal on. A
   * stored value is one set from that panel; see {@link migrateVoicePrefs}.
   */
  showKeptFrame: boolean;
}

export interface VoicePrefsActions {
  setShowUserTranscript: (next: boolean) => void;
  setShowAssistantTranscript: (next: boolean) => void;
  /** Flip `firstRunSeen` to true on first observation. No-op afterwards. */
  markFirstRunSeen: () => void;
  /** `null` clears the preference, handing endpointing back to daemon config. */
  setPauseBeforeReplyMs: (next: number | null) => void;
  /** `null` clears the preference, handing barge-in back to daemon config. */
  setInterruptSensitivity: (next: InterruptSensitivity | null) => void;
  /** Record the flash mode the user picked. See {@link VoicePrefsState.flashMode}. */
  setFlashMode: (next: FlashMode) => void;
  /** Show or hide the kept-frame thumbnail. See {@link VoicePrefsState.showKeptFrame}. */
  setShowKeptFrame: (next: boolean) => void;
}

export type VoicePrefsStore = VoicePrefsState & VoicePrefsActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: VoicePrefsState = {
  showUserTranscript: false,
  showAssistantTranscript: false,
  firstRunSeen: false,
  // Unset until the user picks a value — see the field docs. Omitting the
  // override lets the daemon's configured VAD defaults stand.
  pauseBeforeReplyMs: null,
  interruptSensitivity: null,
  flashMode: "off",
  showKeptFrame: false,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const VOICE_PREFS_STORE_KEY = "vellum:voice-prefs";

/**
 * The persisted shape's version. Anything on disk stamped with a different one,
 * older or newer, goes through {@link migrateVoicePrefs} before it reaches the
 * store.
 */
const VOICE_PREFS_STORE_VERSION = 1;

/**
 * Normalizes a payload written below {@link VOICE_PREFS_STORE_VERSION}, and
 * hands any other one back untouched.
 *
 * Below 1: `showKeptFrame` reads false whether the payload carries it or omits
 * it, and every other field passes through as written. At or above 1: nothing
 * is rewritten, including fields this build has no name for, which ride through
 * in the object it returns. Zustand runs this for every version that is not its
 * own rather than only for older ones, so a payload from a later release
 * arrives here too, and the build that does not know that schema is not the
 * one to edit it.
 *
 * The false is a literal rather than {@link INITIAL_STATE}'s value, because
 * this function is one version's contract and a later default carries its own.
 */
function migrateVoicePrefs(
  persisted: unknown,
  version: number,
): Partial<VoicePrefsState> {
  const saved = persisted as Partial<VoicePrefsState> | undefined;
  if (version >= VOICE_PREFS_STORE_VERSION) {
    return { ...saved };
  }
  return { ...saved, showKeptFrame: false };
}

const useVoicePrefsStoreBase = create<VoicePrefsStore>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,

      setShowUserTranscript: (next: boolean) =>
        set({ showUserTranscript: next }),
      setShowAssistantTranscript: (next: boolean) =>
        set({ showAssistantTranscript: next }),
      markFirstRunSeen: () => {
        if (!get().firstRunSeen) {
          set({ firstRunSeen: true });
        }
      },
      setPauseBeforeReplyMs: (next: number | null) =>
        set({
          pauseBeforeReplyMs:
            next === null ? null : clampPauseBeforeReplyMs(next),
        }),
      setInterruptSensitivity: (next: InterruptSensitivity | null) =>
        set({ interruptSensitivity: next }),
      setFlashMode: (next: FlashMode) => set({ flashMode: next }),
      setShowKeptFrame: (next: boolean) => set({ showKeptFrame: next }),
    }),
    {
      name: VOICE_PREFS_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: VOICE_PREFS_STORE_VERSION,
      migrate: migrateVoicePrefs,
      partialize: (state) => ({
        showUserTranscript: state.showUserTranscript,
        showAssistantTranscript: state.showAssistantTranscript,
        firstRunSeen: state.firstRunSeen,
        pauseBeforeReplyMs: state.pauseBeforeReplyMs,
        interruptSensitivity: state.interruptSensitivity,
        flashMode: state.flashMode,
        showKeptFrame: state.showKeptFrame,
      }),
    },
  ),
);

export const useVoicePrefsStore = createSelectors(useVoicePrefsStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab sync
// ---------------------------------------------------------------------------

/**
 * Whether the payload now on the key was written by a build with a newer
 * schema than this one.
 *
 * Reading one costs more than it gains. Zustand re-persists after every
 * migration it runs, at THIS build's version and through THIS build's
 * `partialize`, so a tab that adopts a newer payload immediately writes back a
 * downgraded one; the newer tab hears that, upgrades it, writes again, and the
 * two trade writes for as long as both are open. Declining to read it ends the
 * trade, and the newer tab keeps the newer payload.
 *
 * Anything unparseable is not a future payload: zustand already handles a
 * broken value, and refusing to read it would strand the tab on stale state.
 */
function isFutureVoicePrefsPayload(raw: string | null): boolean {
  if (raw === null) {
    return false;
  }
  try {
    const version: unknown = (JSON.parse(raw) as { version?: unknown } | null)
      ?.version;
    return typeof version === "number" && version > VOICE_PREFS_STORE_VERSION;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== VOICE_PREFS_STORE_KEY) {
      return;
    }
    if (isFutureVoicePrefsPayload(event.newValue)) {
      return;
    }
    void useVoicePrefsStoreBase.persist.rehydrate();
  });
}
