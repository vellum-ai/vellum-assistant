/**
 * In-session voice settings — the gear the voice room shows in place of a bare
 * captions toggle. Opens a small popover with the settings worth reaching
 * mid-call:
 *
 * - **Captions** — enable/disable the ambient transcript. Purely client-side
 *   (the two `voice-prefs` transcript flags, toggled together), so it applies
 *   instantly. Led by the captions icon, which carries the room's iconographic
 *   control language into the popover.
 * - **Voice** — a row showing the assistant's current TTS voice that opens the
 *   dedicated {@link VoicePickerModal} (the full catalog with per-voice preview
 *   doesn't fit the popover). Writes `services.tts.providers.vellum.model`,
 *   which hot-applies on the assistant's next reply. Managed assistants only;
 *   a bring-your-own provider gets the disabled row and its Settings link (see
 *   {@link VoiceSettingRow}).
 * - **Listening language**: the spoken language STT recognizes, as a row that
 *   opens a small picker modal (mirroring the Voice row: the popover's radix
 *   wrapper is transformed, which makes it the containing block for the
 *   Dropdown menu's fixed-position coordinates, so an inline menu here lands
 *   far from its trigger). Writes `services.stt.language` through
 *   `useSttLanguageSelection`, which hot-applies from the user's next
 *   spoken turn. Only rendered when the daemon reports the configured STT
 *   provider as manually language-selectable; auto-detecting providers and
 *   old daemons get no row. See {@link ListeningLanguageRow} and
 *   {@link ListeningLanguagePickerModal}.
 *
 * Captions are bound to the same `voice-prefs` store the Settings page uses;
 * voice and listening language are bound to daemon config, the source of
 * truth the Settings page's speech cards also write.
 */

import { useState } from "react";

import { Captions, Settings } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Popover } from "@vellumai/design-library/components/popover";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { VoicePickerModal } from "@/components/speech/voice-picker-modal";
import { ListeningLanguagePickerModal } from "@/domains/chat/voice/voice-room/listening-language-picker-modal";
import { ListeningLanguageRow } from "@/domains/chat/voice/voice-room/listening-language-row";
import { VoiceSettingRow } from "@/domains/chat/voice/voice-room/voice-setting-row";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

interface VoiceRoomSettingsMenuProps {
  /** Styling for the gear trigger, so it matches the room's other controls. */
  triggerClassName: string;
  /** Assistant to audition in the voice picker; `null` disables the sample. */
  assistantId: string | null;
}

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
  const [languageModalOpen, setLanguageModalOpen] = useState(false);

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
              {/* Icon + label: the icon ties the row to the captions control
                  the room already shows, the label keeps it level with the
                  Voice row below (an icon alone reads as unlabelled). */}
              <span className="flex items-center gap-2">
                <Captions
                  aria-hidden
                  className="size-5 shrink-0 text-[var(--content-secondary)]"
                />
                <span className="text-body-medium-default text-[var(--content-default)]">
                  Captions
                </span>
              </span>
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

            {/* Listening language → dedicated picker modal, same indirection
                as the Voice row. Only when the daemon reports the configured
                STT provider as language-selectable; collapses to nothing
                otherwise, like the Voice row. */}
            <ListeningLanguageRow
              assistantId={assistantId}
              onOpen={() => {
                setPopoverOpen(false);
                setLanguageModalOpen(true);
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
      <ListeningLanguagePickerModal
        assistantId={assistantId}
        open={languageModalOpen}
        onOpenChange={setLanguageModalOpen}
      />
    </>
  );
}
