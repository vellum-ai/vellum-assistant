import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { VoiceTranscriptToggles } from "@/components/voice-transcript-toggles";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { VOICE_TRANSCRIPT_RECOMMENDATION } from "@/utils/voice-transcript-prefs";

/**
 * One-time preferences card shown the first time a user enters voice mode,
 * before the live session starts.
 *
 * The two transcript toggles are bound to the SAME persisted `voice-prefs`
 * store as the Voice settings page (`settings/pages/voice-page.tsx`), so a
 * choice made here is the choice the settings screen shows — the card is just
 * an earlier, in-context surface for the same preferences. Both default OFF;
 * the "Recommended off" badge and the closing note nudge users to try the
 * hands-free, transcript-free experience first, matching the settings copy.
 *
 * The card does NOT persist `firstRunSeen` itself: dismissing it (Escape /
 * backdrop / ✕) is a plain cancel and must leave the first run un-consumed so
 * the card returns on the next entry. Only committing via "Start" advances the
 * first-run flag, and that lives in the caller's `onStart` handler (the
 * composer) alongside actually starting the session.
 */

/** Mini idle avatar diameter — a quiet, in-context echo of the room avatar. */
const AVATAR_SIZE = 44;

export interface VoiceFirstRunCardProps {
  /** Assistant whose avatar anchors the card; `null` renders the "V" fallback. */
  assistantId: string | null;
  /** Commit: enter voice mode. The caller persists `firstRunSeen` here. */
  onStart: () => void;
  /** Cancel: dismissed without starting (does not consume the first run). */
  onDismiss?: () => void;
}

export function VoiceFirstRunCard({
  assistantId,
  onStart,
  onDismiss,
}: VoiceFirstRunCardProps) {
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        // Escape / backdrop / ✕ all route through here; treat any close as a
        // cancel so the first run stays un-consumed.
        if (!next) {
          onDismiss?.();
        }
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <div className="flex items-center gap-3">
            <span className="shrink-0">
              <ChatAvatar
                components={components}
                traits={traits}
                customImageUrl={customImageUrl}
                size={AVATAR_SIZE}
              />
            </span>
            <Modal.Title>Voice mode</Modal.Title>
          </div>
          <Modal.Description>
            A hands-free, spoken conversation. Speak naturally and your
            assistant listens, then replies out loud.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="flex flex-col gap-1">
            <VoiceTranscriptToggles showRecommendedBadge />
            <p className="pt-2 text-body-small-default text-[var(--content-tertiary)]">
              You can change these anytime in settings.{" "}
              {VOICE_TRANSCRIPT_RECOMMENDATION}
            </p>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={onStart}>
            Start
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
