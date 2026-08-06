/**
 * The voice picker, rendered inline in the transcript: a user who asks to hear
 * or change a voice gets the working picker in the conversation instead of a
 * pointer to Settings. Same {@link VoiceList} the Voice settings page and the
 * voice room render, so a voice is chosen the same way everywhere.
 *
 * **Fires no surface action.** `handleSurfaceAction` requests a send on every
 * non-guardian action, so a per-selection action would cost an assistant turn
 * on every audition click. It needs none: `VoiceList` writes
 * `services.tts.providers.vellum.model` to daemon config itself, and that
 * hot-applies on the assistant's next spoken turn. `onAction` is accepted only
 * to satisfy {@link SurfaceContainer}'s required prop and to keep the router's
 * call shape uniform across surfaces. This component never invokes it.
 *
 * The assistant arrives as a prop rather than from `useActiveAssistantId()`,
 * which throws when nothing is resolved and answers with the globally-active
 * assistant, not necessarily the one that owns this surface's stream.
 */

import { ByoVoiceNote } from "@/components/speech/byo-voice-note";
import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { VoiceList } from "@/components/speech/voice-list";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import type { Surface } from "@/domains/chat/types/types";

interface VoicePickerSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
  assistantId?: string | null;
}

export function VoicePickerSurface({
  surface,
  onAction,
  assistantId,
}: VoicePickerSurfaceProps) {
  const { available, isByok } = useManagedVoiceSelection(assistantId ?? null);

  return (
    <SurfaceContainer surface={surface} onAction={onAction}>
      {available && (
        // Uncontrolled (no `value`/`onChange`) so the list commits the pick
        // itself and it hot-applies, the mode the Settings picker and the voice
        // room use. `showSource` stays off because `filterBySource` already
        // labels the whole list with the chosen provider and drops the per-row
        // badge. Capped so a long catalog can't take over the transcript.
        <VoiceList
          assistantId={assistantId ?? null}
          filterBySource
          className="max-h-[22rem] overflow-y-auto"
        />
      )}
      {/* Gated on `isByok` rather than `!available` so the BYO pointer never
          flashes while config is still loading. */}
      {isByok && <ByoVoiceNote />}
    </SurfaceContainer>
  );
}
