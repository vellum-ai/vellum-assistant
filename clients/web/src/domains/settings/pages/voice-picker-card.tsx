/**
 * Settings → Voice, first card: which voice the assistant speaks in.
 *
 * This is the reason most people open the Voice page, so it leads. It renders
 * the same {@link VoiceList} the voice room's picker uses — full catalog, one
 * description per row, per-voice preview — inline rather than behind a modal,
 * since a settings page has the room the room's popover doesn't.
 *
 * Only managed (Vellum) assistants get a catalog. BYO providers set a voice id
 * on their provider form, which lives with every other provider on Models &
 * Services, so this card points there instead of duplicating that field.
 */

import { Link } from "react-router";

import { DetailCard } from "@/components/detail-card";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { VoiceList } from "@/components/speech/voice-list";
import { routes } from "@/utils/routes";

export function VoicePickerCard() {
  const assistantId = useActiveAssistantId();
  const { available } = useManagedVoiceSelection(assistantId);

  return (
    <DetailCard
      title="Voice"
      subtitle="How your assistant sounds. Changes apply on its next reply, even mid-conversation."
    >
      {available ? (
        <VoiceList assistantId={assistantId} />
      ) : (
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          Your assistant speaks through a provider you configured yourself. Set
          its voice on{" "}
          <Link
            to={routes.settings.ai}
            className="text-[var(--primary-base)] hover:underline"
          >
            Models &amp; Services
          </Link>
          .
        </p>
      )}
    </DetailCard>
  );
}
