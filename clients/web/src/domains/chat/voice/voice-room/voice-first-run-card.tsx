import { AudioLines, Captions, MicOff } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * One-time welcome card shown the first time a user enters voice mode, before
 * the live session starts.
 *
 * Deliberately NOT a settings quiz: captions are toggled in-session from the
 * voice room, and the full preferences live in Settings → Voice —
 * front-loading choices before the user has ever experienced voice mode is
 * the wrong moment. The card just sets expectations and starts.
 *
 * The card does NOT persist `firstRunSeen` itself: dismissing it (Escape /
 * backdrop / ✕) is a plain cancel and must leave the first run un-consumed so
 * the card returns on the next entry. Only committing via "Start" advances the
 * first-run flag, and that lives in the caller's `onStart` handler (the
 * composer) alongside actually starting the session.
 *
 * `nonDismissible` locks the card to a single forward action — no ✕, backdrop,
 * or Escape. The composer sets it on Capacitor iOS, where the card precedes the
 * live-voice `getUserMedia` alert: per `docs/CAPACITOR.md` § OS permission
 * requests (Apple HIG / App Store Review 5.1.1(iv)) such a pre-prompt must lead
 * straight to the system alert, so a dismissible one is disallowed. Locked,
 * there is no card-level cancel by design — backing out means denying the OS
 * mic prompt (or ✕ once the room opens).
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
  /**
   * Lock the card: no ✕ / backdrop / Escape, only "Start talking". Set on
   * Capacitor iOS so the pre-permission card leads straight to the mic alert
   * (see the module docstring). Defaults to dismissible (web).
   */
  nonDismissible?: boolean;
}

export function VoiceFirstRunCard({
  assistantId,
  onStart,
  onDismiss,
  nonDismissible = false,
}: VoiceFirstRunCardProps) {
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);
  const assistantName = useResolvedAssistantsStore.use
    .assistants()
    .find((a) => a.id === assistantId)?.name;

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        // Escape / backdrop / ✕ all route through here; treat any close as a
        // cancel so the first run stays un-consumed. Inert when locked (those
        // affordances are removed / prevented below), so `onDismiss` only fires
        // on the dismissible (web) path.
        if (!next) {
          onDismiss?.();
        }
      }}
    >
      <Modal.Content
        size="sm"
        // iOS lock: strip the ✕, the backdrop-tap dismiss, and Escape so the
        // only way forward is "Start talking" → the mic alert.
        hideCloseButton={nonDismissible}
        dismissOnOverlayClick={!nonDismissible}
        onEscapeKeyDown={
          nonDismissible ? (event) => event.preventDefault() : undefined
        }
        onInteractOutside={
          nonDismissible ? (event) => event.preventDefault() : undefined
        }
      >
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
            A hands-free, spoken conversation with {assistantName ?? "your assistant"}.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          {/* Each bullet's icon matches the in-session control it describes,
              so the card doubles as a legend for the room. */}
          <ul className="flex flex-col gap-4">
            <li className="flex items-start gap-2.5">
              <AudioLines
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-[var(--content-secondary)]"
              />
              <span className="text-body-medium-default">
                Speak naturally and {assistantName ?? "your assistant"} replies
                out loud.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <MicOff
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-[var(--content-secondary)]"
              />
              <span className="text-body-medium-default">
                Mute the mic without ending the session.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Captions
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-[var(--content-secondary)]"
              />
              <span className="text-body-medium-default">
                Turn on live captions anytime.
              </span>
            </li>
          </ul>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={onStart}>
            Start talking
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
