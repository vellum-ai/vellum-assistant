import { useTranslation } from "@/i18n";
/**
 * The voice picker, rendered inline in the transcript: a user who asks to hear
 * or change a voice gets the working picker in the conversation instead of a
 * pointer to Settings. Same {@link VoiceList} the Voice settings page and the
 * voice room render, so a voice is chosen the same way everywhere.
 *
 * **Carries no surface action.** `handleSurfaceAction` requests a send on every
 * non-guardian action, so a per-selection action would cost an assistant turn
 * on every audition click. It needs none: `VoiceList` writes
 * `services.tts.providers.vellum.model` to daemon config itself, and that
 * hot-applies on the assistant's next spoken turn. `onAction` is accepted to
 * satisfy {@link SurfaceContainer}'s required prop and to keep the router's
 * call shape uniform; `SurfaceContainer` only invokes it for actions the
 * surface declares, and no voice picker is given any.
 *
 * Three states, not two, because most of the ways a picker fails to appear are
 * permanent rather than transient: no chrome at all while the daemon queries
 * are in flight, the picker once managed voice selection is available, and a
 * pointer to where the voice actually lives for every settled state in between
 * (a daemon too old to select voices, a catalog that failed or came back empty,
 * no assistant). An empty bordered box is the one unacceptable outcome, since
 * the model has just told the user the picker is here.
 */

import { ByoVoiceNote } from "@/components/speech/byo-voice-note";
import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { VoiceList } from "@/components/speech/voice-list";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import type { Surface } from "@/domains/chat/types/types";
import { MANAGED_VOICE_CREDITS_NOTE } from "@/lib/tts/managed-voice-catalog";

const NOTE_CLASS = "text-body-small-default text-[var(--content-tertiary)]";

interface VoicePickerSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
  assistantId: string | null;
}

export function VoicePickerSurface({
  surface,
  onAction,
  assistantId,
}: VoicePickerSurfaceProps) {
  const { t } = useTranslation("chat");
  // Only the three flags that pick the state. `VoiceList` runs the same hook for
  // the data it renders; both calls share one set of React Query subscriptions.
  const { available, isByok, settled } = useManagedVoiceSelection(assistantId);

  if (!settled) {
    return null;
  }

  return (
    <SurfaceContainer surface={surface} onAction={onAction}>
      {available ? (
        <div className="flex flex-col gap-3">
          {/* Uncontrolled (no `value`/`onChange`): the list commits each pick
              itself and it hot-applies. Every other host is controlled, because
              each owns a Done or Start button that has to wait out an in-flight
              write; this card has no button, so there is nothing to gate. */}
          <VoiceList
            assistantId={assistantId}
            filterBySource
            // Capped on the listbox rather than the wrapper, which also holds
            // the provider dropdown: capping the wrapper scrolls the dropdown
            // out of the card instead of scrolling the voices.
            listClassName="max-h-[22rem]"
          />
          {/* Managed voices bill credits, and every surface that offers them
              says so. This one is reached without opening Settings, so it
              carries the disclosure too. */}
          <p className={NOTE_CLASS}>{MANAGED_VOICE_CREDITS_NOTE}</p>
        </div>
      ) : isByok ? (
        <ByoVoiceNote />
      ) : (
        // Managed, but with nothing to choose from: an old daemon, or a catalog
        // that failed or is empty. The BYO note would be a lie here.
        <p className={NOTE_CLASS}>
          {t("voicePickerSurface.unavailable")}
        </p>
      )}
    </SurfaceContainer>
  );
}
