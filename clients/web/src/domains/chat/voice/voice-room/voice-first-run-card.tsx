import { useState } from "react";
import { Link } from "react-router";

import { ArrowLeft, AudioLines, Captions, MicOff, Settings } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { VoiceList } from "@/components/speech/voice-list";
import { MANAGED_VOICE_CREDITS_NOTE } from "@/lib/tts/managed-voice-catalog";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

/**
 * One-time welcome card shown the first time a user enters voice mode, before
 * the live session starts.
 *
 * Deliberately NOT a settings quiz: captions are toggled in-session from the
 * voice room, the assistant's voice from the room's settings gear (where it
 * hot-applies on the next reply, so the user picks while actually hearing it),
 * and the full preferences live in Settings → Voice — front-loading choices
 * before the user has ever experienced voice mode is the wrong moment. The card
 * just sets expectations and starts.
 *
 * The one exception is the voice settings behind the footer link: the
 * assistant's voice, the one thing most people come here to change. It hides
 * itself for assistants on a bring-your-own provider, whose full config
 * (providers, transcription, keys) lives in Settings → Models & Services — a
 * quiet link points there. The label names a destination rather than an action:
 * the defaults work untouched, and a link reading like a task would imply setup
 * is owed. Quiet by design so it never competes with "Start talking".
 *
 * Those settings are a **view within this one modal**, not a modal stacked on
 * it: entering swaps the card's header and body, and a back arrow returns to the
 * intro. The voice hot-applies on the next reply, so there's no Save. Width is
 * held constant across views so navigating doesn't resize the dialog under the
 * cursor.
 *
 * The card does NOT persist `firstRunSeen` itself: dismissing it (Escape /
 * backdrop / ✕) is a plain cancel and must leave the first run un-consumed so
 * the card returns on the next entry. Only committing via "Start" advances the
 * first-run flag, and that lives in the caller's `onStart` handler (the
 * composer) alongside actually starting the session. Escape inside a sub-view
 * navigates back to the intro rather than cancelling, so a stray keypress
 * can't discard a half-entered API key.
 *
 * `nonDismissible` locks the card to a single forward action — no ✕, backdrop,
 * or Escape. The composer sets it on Capacitor iOS, where the card precedes the
 * live-voice `getUserMedia` alert: per `docs/CAPACITOR.md` § OS permission
 * requests (Apple HIG / App Store Review 5.1.1(iv)) such a pre-prompt must lead
 * straight to the system alert, so a dismissible one is disallowed. Locked,
 * there is no card-level cancel by design — backing out means denying the OS
 * mic prompt (or ✕ once the room opens). The sub-view back arrow is in-modal
 * navigation, not a cancel, so it stays available under the lock.
 */

/** Mini idle avatar diameter — a quiet, in-context echo of the room avatar. */
const AVATAR_SIZE = 44;

/**
 * Which view the card is showing: the welcome content, or the optional voice
 * settings reached from it.
 */
type FirstRunView = "intro" | "settings";

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
  // Managed assistants get the credits subtitle; BYO ones see no catalog here
  // (the note below is their path), so the Vellum-credits line wouldn't apply.
  const { available: managedVoiceAvailable } =
    useManagedVoiceSelection(assistantId);

  const [view, setView] = useState<FirstRunView>("intro");
  const backToIntro = () => setView("intro");

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
        // Held constant across views: a sub-view that resized the dialog would
        // shift the back arrow and ✕ out from under the pointer.
        className="max-w-[520px]"
        // iOS lock: strip the ✕, the backdrop-tap dismiss, and Escape so the
        // only way forward is "Start talking" → the mic alert.
        hideCloseButton={nonDismissible}
        dismissOnOverlayClick={!nonDismissible}
        onEscapeKeyDown={
          // Inside a sub-view Escape is "go back", never "cancel" — it must not
          // discard a half-entered key. On the intro it keeps its normal
          // meaning (cancel), or is swallowed entirely under the lock.
          view !== "intro"
            ? (event) => {
                event.preventDefault();
                backToIntro();
              }
            : nonDismissible
              ? (event) => event.preventDefault()
              : undefined
        }
        onInteractOutside={
          nonDismissible ? (event) => event.preventDefault() : undefined
        }
      >
        {view === "intro" && (
          <>
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
                <div className="flex min-w-0 flex-col">
                  <Modal.Title className="leading-tight">Voice mode</Modal.Title>
                  <Modal.Description>
                    A hands-free, spoken conversation with{" "}
                    {assistantName ?? "your assistant"}.
                  </Modal.Description>
                </div>
              </div>
            </Modal.Header>
            <Modal.Body className="pt-4">
              {/* Each bullet's icon matches the in-session control it describes,
                  so the card doubles as a legend for the room. */}
              <ul className="flex flex-col gap-4">
                <li className="flex items-start gap-2.5">
                  <AudioLines
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-[var(--content-secondary)]"
                  />
                  <span className="text-body-medium-default">
                    Speak naturally and {assistantName ?? "your assistant"}{" "}
                    replies out loud.
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
            <Modal.Footer className="items-center justify-between">
              {/* A destination, not a task: the defaults work, so this names
                  a place to change them rather than asking for setup. The gear
                  is the same control the voice room uses for its in-session
                  settings, so the card previews the affordance the user meets
                  a moment later. Quiet by design — it must not compete with
                  "Start talking". */}
              <button
                type="button"
                onClick={() => setView("settings")}
                className="flex cursor-pointer items-center gap-1.5 rounded text-left text-label-small-default text-[var(--content-tertiary)] underline-offset-2 transition-colors hover:text-[var(--content-secondary)]"
              >
                <Settings aria-hidden className="size-3.5 shrink-0" />
                <span className="hover:underline">Voice settings</span>
              </button>
              <Button variant="primary" onClick={onStart}>
                Start talking
              </Button>
            </Modal.Footer>
          </>
        )}

        {view === "settings" && (
          <>
            <Modal.Header>
              <div className="flex items-center gap-2">
                <BackButton onClick={backToIntro} />
                <div className="flex min-w-0 flex-col">
                  <Modal.Title className="leading-tight">Voices</Modal.Title>
                  {managedVoiceAvailable && (
                    <Modal.Description>
                      {MANAGED_VOICE_CREDITS_NOTE}
                    </Modal.Description>
                  )}
                </div>
              </div>
            </Modal.Header>
            <Modal.Body>
              {/* Just the voice — the one thing most people come here to change,
                  and it hot-applies on the next reply (no Save). A provider
                  dropdown scopes the list; it hides itself for assistants on a
                  bring-your-own provider, leaving the footer note as their path. */}
              <VoiceList assistantId={assistantId} filterBySource />
            </Modal.Body>
            {/* Mirrors the intro footer (fine print left, primary right) and is
                always present, so the picker can flow straight into the session
                without a size change when a voice is chosen. */}
            <Modal.Footer className="items-center justify-between gap-3">
              <p className="text-label-small-default text-[var(--content-tertiary)]">
                Speech providers, transcription, and API keys live in{" "}
                <Link
                  to={`${routes.settings.ai}#text-to-speech`}
                  className="text-[var(--content-secondary)] underline decoration-[var(--border-element)] underline-offset-2 hover:text-[var(--content-default)]"
                >
                  Models &amp; Services
                </Link>
                .
              </p>
              <Button
                variant="primary"
                onClick={onStart}
                className="shrink-0"
              >
                Start talking
              </Button>
            </Modal.Footer>
          </>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}

/** Back to the intro view. In-modal navigation — never a cancel. */
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="compact"
      iconOnly={<ArrowLeft />}
      aria-label="Back"
      onClick={onClick}
      className="-ml-1 shrink-0"
    />
  );
}
