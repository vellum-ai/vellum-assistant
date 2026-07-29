/**
 * The listening-language picker: a small modal hosting
 * {@link ListeningLanguagePickerContent}, kept outside the settings popover
 * (a sibling of {@link VoicePickerModal}) so closing the popover can't
 * unmount it and no transformed ancestor interferes with its positioning. A
 * pick hot-applies from the next spoken turn (there is nothing to save), so
 * it also closes the picker.
 *
 * Selection state is threaded through from the settings menu, which owns the
 * single `useSttLanguageSelection` call (see the content component for why
 * the hook must outlive this modal's content).
 */

import { Modal } from "@vellumai/design-library/components/modal";

import { ListeningLanguagePickerContent } from "@/domains/chat/voice/voice-room/listening-language-picker-content";

export interface ListeningLanguagePickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** See {@link ListeningLanguagePickerContentProps}. */
  currentCode: string;
  configuredProviderId: string;
  selectLanguage: (code: string) => void;
  selecting: boolean;
}

export function ListeningLanguagePickerModal({
  open,
  onOpenChange,
  currentCode,
  configuredProviderId,
  selectLanguage,
  selecting,
}: ListeningLanguagePickerModalProps) {
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        size="sm"
        // Radix autofocuses the first tabbable element on open, which would
        // land a keyboard user on the first option, where Enter overwrites
        // the setting; redirect the open autofocus to the selected option.
        // This must happen in the autofocus hook rather than a mount effect
        // in the content: the hook fires after the dialog's focus trap is
        // already listening, so the trap records the option as the focus to
        // restore when the closing settings popover pulls focus back to its
        // trigger a tick later.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const container = event.target as HTMLElement | null;
          const target =
            container?.querySelector<HTMLButtonElement>(
              '[role="option"][aria-selected="true"]',
            ) ?? container?.querySelector<HTMLButtonElement>('[role="option"]');
          target?.focus();
        }}
      >
        <ListeningLanguagePickerContent
          currentCode={currentCode}
          configuredProviderId={configuredProviderId}
          selectLanguage={selectLanguage}
          selecting={selecting}
          onDone={() => onOpenChange(false)}
        />
      </Modal.Content>
    </Modal.Root>
  );
}
