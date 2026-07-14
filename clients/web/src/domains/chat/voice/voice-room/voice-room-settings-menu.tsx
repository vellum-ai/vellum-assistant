/**
 * In-session voice settings — the gear the voice room shows in place of a bare
 * captions toggle. Opens a small popover exposing the two settings worth
 * reaching mid-call:
 *
 * - **Captions** — enable/disable the ambient transcript. Purely client-side
 *   (the two `voice-prefs` transcript flags, toggled together), so it applies
 *   instantly.
 * - **Pause before reply** — the trailing-silence "pause" the server VAD waits
 *   before the assistant replies. Persisted to the same `voice-prefs` store as
 *   Settings → Voice AND pushed to the running session via
 *   {@link updateLiveVoiceSessionConfig}, so a change takes effect on the next
 *   utterance without reconnecting.
 *
 * Both controls are bound to the same store the Settings page and first-run
 * card use, so a choice made here is the choice those surfaces show.
 */

import { Settings } from "lucide-react";

import { Popover } from "@vellumai/design-library/components/popover";
import { Slider } from "@vellumai/design-library/components/slider";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { updateLiveVoiceSessionConfig } from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  DEFAULT_PAUSE_BEFORE_REPLY_MS,
  MAX_PAUSE_BEFORE_REPLY_MS,
  MIN_PAUSE_BEFORE_REPLY_MS,
  useVoicePrefsStore,
} from "@/stores/voice-prefs-store";

interface VoiceRoomSettingsMenuProps {
  /** Styling for the gear trigger, so it matches the room's other controls. */
  triggerClassName: string;
}

export function VoiceRoomSettingsMenu({
  triggerClassName,
}: VoiceRoomSettingsMenuProps) {
  const showUserTranscript = useVoicePrefsStore.use.showUserTranscript();
  const showAssistantTranscript =
    useVoicePrefsStore.use.showAssistantTranscript();
  const captionsOn = showUserTranscript || showAssistantTranscript;
  const setCaptions = (on: boolean) => {
    const prefs = useVoicePrefsStore.getState();
    prefs.setShowUserTranscript(on);
    prefs.setShowAssistantTranscript(on);
  };

  const pauseMs = useVoicePrefsStore.use.pauseBeforeReplyMs();
  const setPauseMs = useVoicePrefsStore.use.setPauseBeforeReplyMs();
  const handlePauseChange = (next: number | [number, number]) => {
    const seconds = typeof next === "number" ? next : next[0];
    setPauseMs(Math.round(seconds * 1000));
    // The setter clamps; read the applied value back and push it to the live
    // session so the new pause takes effect on the next utterance.
    const applied = useVoicePrefsStore.getState().pauseBeforeReplyMs;
    if (applied !== null) {
      updateLiveVoiceSessionConfig({ silenceThresholdMs: applied });
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Voice settings"
          title="Voice settings"
          className={triggerClassName}
        >
          <Settings className="size-5" />
        </button>
      </Popover.Trigger>
      <Popover.Content side="bottom" align="end" sideOffset={8} className="w-64">
        <div className="flex flex-col gap-4 p-1">
          <label className="flex items-center justify-between gap-3">
            <span className="text-body-medium-default text-[var(--content-default)]">
              Captions
            </span>
            <Toggle
              checked={captionsOn}
              onChange={setCaptions}
              aria-label="Show captions"
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-body-medium-default text-[var(--content-default)]">
              Pause before reply
            </span>
            <Slider
              value={(pauseMs ?? DEFAULT_PAUSE_BEFORE_REPLY_MS) / 1000}
              onValueChange={handlePauseChange}
              min={MIN_PAUSE_BEFORE_REPLY_MS / 1000}
              max={MAX_PAUSE_BEFORE_REPLY_MS / 1000}
              step={0.1}
              showValue
              formatValue={(value) =>
                `${(typeof value === "number" ? value : value[0]).toFixed(1)}s`
              }
              aria-label="Pause before reply"
            />
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
