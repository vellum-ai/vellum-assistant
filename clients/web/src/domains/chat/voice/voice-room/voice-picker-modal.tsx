/**
 * The voice-picker modal ("Pick a voice for <assistant>"), opened from the
 * voice-room settings popover's Voice row. Gives voice selection the room the
 * cramped popover can't: every voice's full description on its own line with a
 * per-voice preview.
 *
 * Selecting a voice persists it (hot-applies on the next reply) and closes the
 * modal. The list itself lives in {@link VoiceList}; the first-run card renders
 * that list as one of its own views, so this modal serves only popover callers,
 * which have no dialog of their own to stack on.
 */

import { Modal } from "@vellumai/design-library/components/modal";

import { VoiceList } from "@/components/speech/voice-list";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export interface VoicePickerModalProps {
  assistantId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VoicePickerModal({
  assistantId,
  open,
  onOpenChange,
}: VoicePickerModalProps) {
  const assistantName = useResolvedAssistantsStore.use
    .assistants()
    .find((a) => a.id === assistantId)?.name;

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>
            Pick a voice for {assistantName ?? "your assistant"}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <VoiceList
            assistantId={assistantId}
            onSelect={() => onOpenChange(false)}
          />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
