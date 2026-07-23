/**
 * Settings → Voice, output section: which voice the assistant speaks in.
 *
 * Title on top, control below — the layout every other card on the page uses.
 * The current voice sits on its own row under the title with Change beside it,
 * opening the full catalog (grouped, with per-voice preview) in the same
 * {@link VoicePickerModal} the voice room uses, so a voice is chosen the same
 * way everywhere. No subtitle: the Output section header already says "How your
 * assistant sounds".
 *
 * Only managed (Vellum) assistants get a catalog. BYO providers set a voice id
 * on their provider form, which lives with every other provider on Models &
 * Services, so this card points there instead of duplicating that field.
 */

import { useState } from "react";

import { Link } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { DetailCard } from "@/components/detail-card";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { VoiceLabel } from "@/components/speech/voice-list";
import { VoicePickerModal } from "@/components/speech/voice-picker-modal";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { routes } from "@/utils/routes";

export function VoicePickerCard() {
  const assistantId = useActiveAssistantId();
  const { available, voices, currentModel } =
    useManagedVoiceSelection(assistantId);
  const current = voices.find((v) => v.model === currentModel) ?? voices[0];
  const [pickerOpen, setPickerOpen] = useState(false);

  // Name the card after the assistant so the "output = theirs" read lands (the
  // input cards below stay plain — those are yours). Falls back to a bare
  // "Voice" when the assistant has no name yet, never "'s Voice".
  const assistantName = useAssistantIdentityStore.use.name();
  const voiceTitle = assistantName ? `${assistantName}’s Voice` : "Voice";

  if (available && current) {
    return (
      <DetailCard
        title={voiceTitle}
        subtitle="Uses Vellum credits, through providers like ElevenLabs and Deepgram."
      >
        <div className="flex items-center gap-3">
          <VoiceLabel
            description={current.description}
            // Lighter weight than the title differentiates value from heading
            // (they were both medium and blurred together); full-strength color
            // keeps it a legible value, not the muted grey of a description. The
            // "· accent" tail stays quiet (VoiceLabel renders it in tertiary).
            className="min-w-0 text-body-medium-lighter text-[var(--content-default)]"
          />
          <Button
            variant="outlined"
            onClick={() => setPickerOpen(true)}
            className="shrink-0"
          >
            Change
          </Button>
        </div>
        <VoicePickerModal
          assistantId={assistantId}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          filterBySource
        />
      </DetailCard>
    );
  }

  return (
    <DetailCard title={voiceTitle}>
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
    </DetailCard>
  );
}
