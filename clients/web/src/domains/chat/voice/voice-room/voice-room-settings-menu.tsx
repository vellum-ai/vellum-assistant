/**
 * In-session voice settings — the gear the voice room shows in place of a bare
 * captions toggle. Opens a small popover with the settings worth reaching
 * mid-call:
 *
 * - **Captions** — enable/disable the ambient transcript. Purely client-side
 *   (the two `voice-prefs` transcript flags, toggled together), so it applies
 *   instantly.
 * - **Voice** — a row showing the assistant's current TTS voice that opens the
 *   dedicated {@link VoicePickerModal} (the full catalog with per-voice preview
 *   doesn't fit the popover). Writes `services.tts.providers.vellum.model`,
 *   which hot-applies on the assistant's next reply. Managed assistants only.
 *
 * Captions are bound to the same `voice-prefs` store the Settings page uses;
 * voice is bound to daemon config, the source of truth the Settings → Voice
 * card also writes.
 */

import { useState } from "react";

import { Settings } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Popover } from "@vellumai/design-library/components/popover";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { VoicePickerModal } from "@/domains/chat/voice/voice-room/voice-picker-modal";
import { VoiceSettingRow } from "@/domains/chat/voice/voice-room/voice-setting-row";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

interface VoiceRoomSettingsMenuProps {
  /** Styling for the gear trigger, so it matches the room's other controls. */
  triggerClassName: string;
  /** Assistant to audition in the voice picker; `null` disables the sample. */
  assistantId: string | null;
}

const rowLabelClass = "text-body-medium-default text-[var(--content-default)]";

export function VoiceRoomSettingsMenu({
  triggerClassName,
  assistantId,
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

  // Voice selection is a bigger surface than the popover fits, so its row opens
  // a dedicated modal. Controlling the popover lets the row close it before the
  // modal opens; the modal lives outside the popover so that close doesn't
  // unmount it.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);

  return (
    <>
      <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Voice settings"
            title="Voice settings"
            className={cn(
              triggerClassName,
              // Show the active (open) state with the same room tokens the
              // control's hover uses.
              "data-[state=open]:bg-[var(--room-wash)] data-[state=open]:text-[var(--room-fg)]",
            )}
          >
            <Settings className="size-5" />
          </button>
        </Popover.Trigger>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          className="w-64 p-3"
        >
          <div className="flex flex-col">
            <label className="flex items-center justify-between gap-3 py-1">
              <span className={rowLabelClass}>Captions</span>
              <Toggle
                checked={captionsOn}
                onChange={setCaptions}
                aria-label="Show captions"
              />
            </label>

            {/* Voice row → dedicated picker modal. Only for managed assistants
                that offer voice selection; collapses to nothing (divider and
                all) otherwise. Closes the popover as it opens the modal. */}
            <VoiceSettingRow
              assistantId={assistantId}
              onOpen={() => {
                setPopoverOpen(false);
                setVoiceModalOpen(true);
              }}
              className="mt-2"
            />
          </div>
        </Popover.Content>
      </Popover.Root>
      <VoicePickerModal
        assistantId={assistantId}
        open={voiceModalOpen}
        onOpenChange={setVoiceModalOpen}
      />
    </>
  );
}
