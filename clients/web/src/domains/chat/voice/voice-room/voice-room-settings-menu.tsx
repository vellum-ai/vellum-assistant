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
 *   {@link useSttLanguageSelection}, which hot-applies from the user's next
 *   spoken turn. Only rendered when the daemon reports the configured STT
 *   provider as manually language-selectable; auto-detecting providers and
 *   old daemons get no row.
 *
 * Captions are bound to the same `voice-prefs` store the Settings page uses;
 * voice and listening language are bound to daemon config, the source of
 * truth the Settings page's speech cards also write.
 */

import { useState } from "react";

import { Captions, Check, ChevronRight, Settings } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Modal } from "@vellumai/design-library/components/modal";
import { Popover } from "@vellumai/design-library/components/popover";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { useSttLanguageSelection } from "@/components/speech/use-stt-language-selection";
import { VoicePickerModal } from "@/components/speech/voice-picker-modal";
import { VoiceSettingRow } from "@/domains/chat/voice/voice-room/voice-setting-row";
import {
  sttLanguageOptionsFor,
  type SttLanguageOption,
} from "@/lib/stt/language-catalog";
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

/** One display string per option, shared by the row's value and the picker. */
function languageLabel(option: SttLanguageOption): string {
  return option.nativeLabel
    ? `${option.label} (${option.nativeLabel})`
    : option.label;
}

/**
 * The "Listening language" row: the current language with a chevron, leading
 * to {@link ListeningLanguagePickerModal}. Renders nothing when the daemon
 * doesn't offer manual language selection for the configured STT provider
 * (auto-detecting providers, old daemons), so the popover never shows a
 * control the daemon would ignore.
 *
 * The picker is a modal rather than an inline dropdown on purpose: the radix
 * popover positions its content through a transformed wrapper, which becomes
 * the containing block for fixed-position descendants, so the Dropdown menu's
 * viewport coordinates land relative to the already-offset popover and the
 * options render far from the trigger. Like the Voice row, this row only
 * reports the click via `onOpen`; the parent closes the popover and opens the
 * modal it owns outside it.
 */
function ListeningLanguageRow({
  assistantId,
  onOpen,
  className,
}: {
  assistantId: string | null;
  /** Open the language picker modal (owned by the parent). */
  onOpen: () => void;
  className?: string;
}) {
  const { available, currentCode, configuredProviderId } =
    useSttLanguageSelection(assistantId);

  if (!available) {
    return null;
  }

  const current = sttLanguageOptionsFor(currentCode, configuredProviderId).find(
    (option) => option.code === currentCode,
  );

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Same straight full-width divider the Voice row draws (a border on a
          rounded child would render with rounded ends). */}
      <div className="border-t border-[var(--border-subtle)]" />
      <button
        type="button"
        onClick={onOpen}
        className="mt-1 flex w-full items-baseline gap-2 rounded-md px-1 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <span className="shrink-0 text-body-medium-default text-[var(--content-default)]">
          Listening language
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-label-small-default text-[var(--content-tertiary)]">
          {current ? languageLabel(current) : currentCode}
        </span>
        <ChevronRight className="size-4 shrink-0 self-center text-[var(--content-tertiary)]" />
      </button>
    </div>
  );
}

/**
 * The listening-language picker: the short static catalog as a selectable
 * list in a small modal, hosted outside the settings popover (a sibling of
 * {@link VoicePickerModal}) so closing the popover can't unmount it and no
 * transformed ancestor interferes with its positioning. A pick hot-applies
 * from the next spoken turn (there is nothing to save), so it also closes
 * the picker.
 */
function ListeningLanguagePickerModal({
  assistantId,
  open,
  onOpenChange,
}: {
  assistantId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="sm">
        {/* Own component so its daemon queries run only while the modal is
            open — the host keeps this mounted across a whole session. */}
        <ListeningLanguagePickerContent
          assistantId={assistantId}
          onDone={() => onOpenChange(false)}
        />
      </Modal.Content>
    </Modal.Root>
  );
}

function ListeningLanguagePickerContent({
  assistantId,
  onDone,
}: {
  assistantId: string | null;
  onDone: () => void;
}) {
  const { currentCode, configuredProviderId, selectLanguage, selecting } =
    useSttLanguageSelection(assistantId);

  return (
    <>
      <Modal.Header>
        <Modal.Title>Listening language</Modal.Title>
        <Modal.Description>
          Applies from your next spoken turn.
        </Modal.Description>
      </Modal.Header>
      <Modal.Body>
        <div
          role="listbox"
          aria-label="Listening language"
          className={cn(
            "flex max-h-[60vh] flex-col overflow-y-auto",
            selecting && "pointer-events-none opacity-70",
          )}
        >
          {sttLanguageOptionsFor(currentCode, configuredProviderId).map(
            (option) => {
              const isSelected = option.code === currentCode;
              return (
                <div
                  key={option.code}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    selectLanguage(option.code);
                    onDone();
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 transition-colors",
                    // Selected reads as a soft persistent fill + a trailing
                    // check, like the voice list — not a form-field border.
                    isSelected
                      ? "bg-[var(--surface-active)]"
                      : "hover:bg-[var(--surface-hover)]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
                    {languageLabel(option)}
                    {option.description && (
                      <span className="block truncate text-label-small-default text-[var(--content-tertiary)]">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {isSelected && (
                    <Check
                      aria-hidden
                      className="size-4 shrink-0 text-[var(--system-positive-strong)]"
                    />
                  )}
                </div>
              );
            },
          )}
        </div>
      </Modal.Body>
    </>
  );
}
