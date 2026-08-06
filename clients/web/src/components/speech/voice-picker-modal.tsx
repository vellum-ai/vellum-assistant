/**
 * The voice-picker modal: the full catalog with every voice's description on
 * its own line and a per-voice preview — what a cramped trigger can't hold.
 * Serves the callers with no dialog of their own to host the list: the
 * voice-room settings popover and the Settings voice card.
 *
 * Deliberately the same surface as the first-run card's "Voices" view (which
 * renders {@link VoiceList} inline as one of its own views, so it can't share
 * this dialog): same title, same managed-credits subtitle, the same
 * provider-scoped list, and the same Models & Services fine print. Picking a
 * voice is chosen the same way everywhere.
 *
 * Selection is held here rather than left to the list so a pick doesn't close
 * the modal — auditioning several voices in a row is the whole point, and each
 * one hot-applies on the assistant's next reply (there is nothing to save).
 * Done is the only exit, and it waits out an in-flight write.
 */

import { Modal } from "@vellumai/design-library/components/modal";
import { Button } from "@vellumai/design-library/components/button";

import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { VoiceList } from "@/components/speech/voice-list";
import { VoiceProvidersNote } from "@/components/speech/voice-providers-note";
import { MANAGED_VOICE_CREDITS_NOTE } from "@/lib/tts/managed-voice-catalog";

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
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="md">
        {/* The picker's own component, so its daemon queries run only while the
            modal is open — hosts keep this mounted across a whole session (the
            voice room parks it outside its popover), and a closed dialog has no
            business holding a React Query subscription. */}
        <VoicePickerContent
          assistantId={assistantId}
          onDone={() => onOpenChange(false)}
        />
      </Modal.Content>
    </Modal.Root>
  );
}

function VoicePickerContent({
  assistantId,
  onDone,
}: {
  assistantId: string | null;
  onDone: () => void;
}) {
  const { available, currentModel, selectModel, selecting } =
    useManagedVoiceSelection(assistantId);

  return (
    <>
      <Modal.Header>
        <Modal.Title>Voices</Modal.Title>
        {available && (
          <Modal.Description>{MANAGED_VOICE_CREDITS_NOTE}</Modal.Description>
        )}
      </Modal.Header>
      <Modal.Body>
        {/* Provider-scoped, like the first-run view: a dropdown picks the
            upstream source so accent grouping isn't split across providers.
            It hides itself when the catalog has a single provider. */}
        <VoiceList
          assistantId={assistantId}
          filterBySource
          value={currentModel}
          onChange={selectModel}
        />
      </Modal.Body>
      <Modal.Footer className="items-center justify-between gap-3">
        <VoiceProvidersNote />
        <Button
          variant="primary"
          onClick={onDone}
          disabled={selecting}
          className="shrink-0"
        >
          Done
        </Button>
      </Modal.Footer>
    </>
  );
}
