/**
 * App-root wiring for the in-app sound system.
 *
 * Mounted once from `root-layout` so the shared `SoundManager` singleton is
 * live on every route — not only the Settings → Sounds page. Without this the
 * manager has no config/identity and `play()` short-circuits everywhere except
 * the settings preview buttons. Three responsibilities:
 *
 *  1. Identity/config sync — pushes the active assistant id, the workspace
 *     `data/sounds/config.json` payload, and the feature-enabled flag into the
 *     manager so `play(event)` can resolve a sound from anywhere in the app.
 *  2. Turn-outcome chimes — subscribes to the turn store and plays
 *     `task_complete` / `task_failed` / `needs_input` on the matching phase
 *     transitions. Only the local user's send drives the turn store through a
 *     sending phase, so background (Slack/scheduler) turns stay silent —
 *     matching the macOS app's user-initiated-only gating.
 *  3. Random ambient timer — re-creates the macOS `RandomSoundTimer`: plays the
 *     `random` event on a jittered 5–30 minute interval. The manager applies the
 *     global/per-event enabled checks internally, so the timer just ticks.
 *
 * The manager no-ops `play()` when sounds are globally disabled or the event is
 * unconfigured, so the subscription and timer can stay mounted unconditionally.
 */

import { useEffect } from "react";

import { useQuery } from "@tanstack/react-query";

import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { getSoundManager } from "@/lib/sounds/sound-manager";
import { soundsConfigGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

const RANDOM_SOUND_MIN_MS = 5 * 60 * 1000;
const RANDOM_SOUND_MAX_MS = 30 * 60 * 1000;

export function useSoundEffects(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const enabled = isAssistantActive && !!assistantId;

  const { data: config } = useQuery({
    ...soundsConfigGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
  });

  // Keep the singleton's identity/config/enabled state current.
  useEffect(() => {
    const manager = getSoundManager();
    manager.setAssistantId(assistantId);
    manager.setConfig(config ?? null);
    manager.setFeatureEnabled(enabled);
  }, [assistantId, config, enabled]);

  // Turn-outcome chimes. `subscribe` fires on every turn-store change; the
  // phase-equality guard keeps the body cheap during high-cadence streaming.
  useEffect(() => {
    return useTurnStore.subscribe((state, prev) => {
      if (state.phase === prev.phase) return;
      if (state.phase === "awaiting_user_input") {
        void getSoundManager().play("needs_input");
        return;
      }
      if (isSending(prev.phase) && state.phase === "idle") {
        if (state.lastTerminalReason === "complete") {
          void getSoundManager().play("task_complete");
        } else if (
          state.lastTerminalReason === "error" ||
          state.lastTerminalReason === "session_error"
        ) {
          void getSoundManager().play("task_failed");
        }
      }
    });
  }, []);

  // Random ambient sound on a jittered 5–30 min interval.
  useEffect(() => {
    let timer: number;
    let cancelled = false;
    const scheduleNext = () => {
      const interval =
        RANDOM_SOUND_MIN_MS +
        Math.random() * (RANDOM_SOUND_MAX_MS - RANDOM_SOUND_MIN_MS);
      timer = window.setTimeout(() => {
        if (cancelled) return;
        void getSoundManager().play("random");
        scheduleNext();
      }, interval);
    };
    scheduleNext();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
}
