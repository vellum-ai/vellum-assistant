import { Toggle } from "@vellumai/design-library/components/toggle";

import { useVoicePrefsStore } from "@/stores/voice-prefs-store";
import {
  VOICE_TRANSCRIPT_TOGGLES,
  type VoiceTranscriptPrefKey,
} from "@/utils/voice-transcript-prefs";

/** "Recommended off" pill shown next to a toggle label on the first-run card. */
function RecommendedOffBadge() {
  return (
    <span className="shrink-0 rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
      Recommended off
    </span>
  );
}

function TranscriptToggleRow({
  label,
  description,
  showBadge,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  showBadge?: boolean;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body-medium-lighter text-[var(--content-default)]">
            {label}
          </span>
          {showBadge ? <RecommendedOffBadge /> : null}
        </div>
        {description ? (
          <div className="text-body-small-default text-[var(--content-tertiary)]">
            {description}
          </div>
        ) : null}
      </div>
      <Toggle checked={checked} onChange={onChange} aria-label={label} />
    </div>
  );
}

export interface VoiceTranscriptTogglesProps {
  /** Render each toggle's one-line description beneath its label. */
  showDescription?: boolean;
  /** Show a "Recommended off" pill next to each toggle label. */
  showRecommendedBadge?: boolean;
}

/**
 * The two transcript-visibility toggles ("show the words you say" / "...the
 * assistant says") bound to the shared `voice-prefs` store.
 *
 * Rendered by both the Voice settings page and the voice first-run card so the
 * copy and store wiring live in exactly one place. Each surface supplies its
 * own surrounding layout (settings `DetailCard`, first-run modal body) and the
 * closing recommendation line via `VOICE_TRANSCRIPT_RECOMMENDATION`; this
 * component owns only the repeated rows.
 */
export function VoiceTranscriptToggles({
  showDescription = false,
  showRecommendedBadge = false,
}: VoiceTranscriptTogglesProps) {
  const showUserTranscript = useVoicePrefsStore.use.showUserTranscript();
  const showAssistantTranscript =
    useVoicePrefsStore.use.showAssistantTranscript();
  const setShowUserTranscript = useVoicePrefsStore.use.setShowUserTranscript();
  const setShowAssistantTranscript =
    useVoicePrefsStore.use.setShowAssistantTranscript();

  const bindings: Record<
    VoiceTranscriptPrefKey,
    { checked: boolean; onChange: (next: boolean) => void }
  > = {
    showUserTranscript: {
      checked: showUserTranscript,
      onChange: setShowUserTranscript,
    },
    showAssistantTranscript: {
      checked: showAssistantTranscript,
      onChange: setShowAssistantTranscript,
    },
  };

  return (
    <>
      {VOICE_TRANSCRIPT_TOGGLES.map((def) => {
        const binding = bindings[def.prefKey];
        return (
          <TranscriptToggleRow
            key={def.prefKey}
            label={def.label}
            description={showDescription ? def.description : undefined}
            showBadge={showRecommendedBadge}
            checked={binding.checked}
            onChange={binding.onChange}
          />
        );
      })}
    </>
  );
}
