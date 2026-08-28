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

import { Button } from "@vellumai/design-library/components/button";
import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { DetailCard } from "@/components/detail-card";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ByoVoiceNote } from "@/components/speech/byo-voice-note";
import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { VoiceLabel } from "@/components/speech/voice-list";
import { VoicePickerModal } from "@/components/speech/voice-picker-modal";
import { useTranslation } from "@/i18n";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

export function VoicePickerCard() {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const { available, settled, voices, currentModel } =
    useManagedVoiceSelection(assistantId);
  const current = voices.find((v) => v.model === currentModel) ?? voices[0];
  const [pickerOpen, setPickerOpen] = useState(false);

  // Name the card after the assistant so the "output = theirs" read lands (the
  // input cards below stay plain — those are yours). Falls back to a bare
  // "Voice" when the assistant has no name yet, never "'s Voice".
  const assistantName = useAssistantIdentityStore.use.name();
  const voiceTitle = assistantName
    ? t("voicePickerCard.titleWithName", { name: assistantName })
    : t("voicePickerCard.title");

  // The title needs nothing from the daemon, so the card holds its heading
  // through the wait and only the body below it changes. `available` reads
  // false while the answer is in flight as well as once it is a no, so drawing
  // either outcome now claims a provider choice the user may not have made.
  if (!settled) {
    return (
      <DetailCard title={voiceTitle}>
        <Skeleton
          as="span"
          role="status"
          aria-label={t("voicePickerCard.loadingAria")}
          className="block h-9 w-48"
        />
      </DetailCard>
    );
  }

  if (available && current) {
    return (
      <DetailCard
        title={voiceTitle}
        subtitle={t("voicePickerCard.creditsNote")}
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
            {t("voicePickerCard.changeButton")}
          </Button>
        </div>
        <VoicePickerModal
          assistantId={assistantId}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
      </DetailCard>
    );
  }

  return (
    <DetailCard title={voiceTitle}>
      <ByoVoiceNote />
    </DetailCard>
  );
}
