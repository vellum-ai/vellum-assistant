/**
 * A small modal hosting {@link SttLanguagePicker} for surfaces that open the
 * picker as a dialog: the Speech-to-Text settings form and the voice room
 * (where it lives outside the settings popover so closing the popover can't
 * unmount it and no transformed ancestor interferes with its positioning).
 * The voice first-run card hosts the picker as an in-modal sub-view instead,
 * per its one-dialog pattern. A pick hot-applies from the next spoken turn
 * (there is nothing to save), so it also closes the picker.
 *
 * Selection state is threaded through from the host, which owns the single
 * `useSttLanguageSelection` call (see the picker component for why the hook
 * must outlive this modal's content).
 */

import { Modal } from "@vellumai/design-library/components/modal";

import { SttLanguagePicker } from "@/components/speech/stt-language-picker";

export interface SttLanguagePickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog title; the hosting surfaces name the control differently. */
  title: string;
  /** See {@link SttLanguagePickerProps}. */
  currentCode: string;
  configuredProviderId: string;
  suggestedCode?: string | null;
  selectLanguage: (code: string) => void;
  selecting: boolean;
}

export function SttLanguagePickerModal({
  open,
  onOpenChange,
  title,
  currentCode,
  configuredProviderId,
  suggestedCode,
  selectLanguage,
  selecting,
}: SttLanguagePickerModalProps) {
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        size="sm"
        // Radix autofocuses the first tabbable element on open; redirect the
        // open autofocus to the picker's search field so the first keystroke
        // filters. This must happen in the autofocus hook rather than only a
        // mount effect in the content: the hook fires after the dialog's
        // focus trap is already listening, so the trap records the field as
        // the focus to restore when a closing ancestor (the voice room's
        // settings popover) pulls focus back to its trigger a tick later.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const container = event.target as HTMLElement | null;
          container
            ?.querySelector<HTMLInputElement>('input[role="combobox"]')
            ?.focus();
        }}
      >
        <Modal.Header>
          <Modal.Title>{title}</Modal.Title>
          <Modal.Description>
            Applies from your next spoken turn.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <SttLanguagePicker
            currentCode={currentCode}
            configuredProviderId={configuredProviderId}
            suggestedCode={suggestedCode}
            selectLanguage={selectLanguage}
            selecting={selecting}
            onDone={() => onOpenChange(false)}
          />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
