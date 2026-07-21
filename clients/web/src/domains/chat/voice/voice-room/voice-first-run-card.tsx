import { useState } from "react";

import { ArrowLeft, AudioLines, Captions, MicOff } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { VoiceList } from "@/domains/chat/voice/voice-room/voice-list";
import { VoiceSettingRow } from "@/domains/chat/voice/voice-room/voice-setting-row";
import { SttProviderForm } from "@/components/speech/stt-provider-form";
import { TtsProviderForm } from "@/components/speech/tts-provider-form";
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
 * Two deliberate exceptions, both reached from the intro view and both
 * optional:
 *   - Voice selection: how the assistant *sounds* is an identity choice, not a
 *     preference dial, and this is the natural moment to make it — before the
 *     first word is spoken. A default is pre-selected, so the card still leads
 *     straight to "Start talking".
 *   - Bringing your own STT/TTS key: the quiet link under the footer, for users
 *     who would rather run voice on their own providers than the managed ones.
 *     Quiet by design — managed is the path nearly everyone should take.
 *
 * Both are **views within this one modal**, not modals stacked on top of it:
 * the card swaps its header, body, and footer for the sub-view and offers a
 * back arrow. Width is held constant across views so navigating doesn't resize
 * the dialog under the cursor.
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
 * Which view the card is showing. `intro` is the welcome content; the other
 * two are the optional detours, each reached from the intro and each returning
 * to it.
 */
type FirstRunView = "intro" | "voice" | "byok";

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
        className="max-w-[440px]"
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
                  <Modal.Title>Voice mode</Modal.Title>
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

              {/* Voice row → the in-card picker view. Only for managed
                  assistants that offer voice selection; collapses to nothing
                  (border and all) otherwise. */}
              <VoiceSettingRow
                assistantId={assistantId}
                onOpen={() => setView("voice")}
                className="mt-5"
              />
            </Modal.Body>
            <Modal.Footer className="items-center justify-between">
              {/* Quiet by design: managed speech is the path nearly everyone
                  should take, so this reads as an escape hatch, not an
                  alternative of equal weight. */}
              <button
                type="button"
                onClick={() => setView("byok")}
                className="cursor-pointer rounded text-left text-label-small-default text-[var(--content-tertiary)] underline-offset-2 transition-colors hover:text-[var(--content-secondary)] hover:underline"
              >
                I have my own STT/TTS API key
              </button>
              <Button variant="primary" onClick={onStart}>
                Start talking
              </Button>
            </Modal.Footer>
          </>
        )}

        {view === "voice" && (
          <>
            <Modal.Header>
              <div className="flex items-center gap-2">
                <BackButton onClick={backToIntro} />
                <Modal.Title>
                  Pick a voice for {assistantName ?? "your assistant"}
                </Modal.Title>
              </div>
            </Modal.Header>
            <Modal.Body>
              {/* Selecting persists the voice (it hot-applies on the next
                  reply) and returns to the intro — the card's forward action
                  stays "Start talking". */}
              <VoiceList assistantId={assistantId} onSelect={backToIntro} />
            </Modal.Body>
          </>
        )}

        {view === "byok" && (
          <>
            <Modal.Header>
              <div className="flex items-center gap-2">
                <BackButton onClick={backToIntro} />
                <div className="flex min-w-0 flex-col">
                  <Modal.Title>Use your own API keys</Modal.Title>
                  <Modal.Description>
                    Run voice on your own providers instead of the managed ones.
                  </Modal.Description>
                </div>
              </div>
            </Modal.Header>
            <Modal.Body className="space-y-6">
              {/* The same forms Settings → AI renders, minus that page's card
                  chrome. Saving either one returns to the intro so the user
                  lands back on "Start talking". */}
              <section className="space-y-3">
                <h3 className="text-label-medium-default text-[var(--content-secondary)]">
                  Speech to text
                </h3>
                <SttProviderForm
                  assistantId={assistantId ?? undefined}
                  onSaved={backToIntro}
                />
              </section>
              <section className="space-y-3 border-t border-[var(--border-subtle)] pt-5">
                <h3 className="text-label-medium-default text-[var(--content-secondary)]">
                  Text to speech
                </h3>
                <TtsProviderForm
                  assistantId={assistantId ?? undefined}
                  onSaved={backToIntro}
                />
              </section>
            </Modal.Body>
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
