/**
 * The voice-picker modal ("Pick a voice for <assistant>"). Gives voice
 * selection the room a cramped trigger can't: every voice's full description on
 * its own line with a per-voice preview.
 *
 * Selecting a voice persists it (hot-applies on the next reply) and closes the
 * modal. The list itself lives in {@link VoiceList}; the first-run card renders
 * that list inline as one of its own views, so this modal serves callers with
 * no dialog of their own to host the list — the voice-room settings popover and
 * the Voice settings page's picker card.
 */

import { Modal } from "@vellumai/design-library/components/modal";

import { VoiceList } from "@/components/speech/voice-list";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export interface VoicePickerModalProps {
  assistantId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Show each voice's provider badge (settings surfaces). */
  showSource?: boolean;
}

export function VoicePickerModal({
  assistantId,
  open,
  onOpenChange,
  showSource = false,
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
            showSource={showSource}
          />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
