import { type ReactNode, useState } from "react";

import { ArrowLeft, AudioLines, Captions, MicOff } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { ProviderFormSaveHandle } from "@/components/service-form-controls";
import { SttProviderForm } from "@/components/speech/stt-provider-form";
import { TtsProviderForm } from "@/components/speech/tts-provider-form";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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
 * The one exception is bringing your own STT/TTS key: a quiet link in the
 * footer for users who would rather run voice on their own providers than the
 * managed ones. It has to live here because it gates whether voice works at
 * all. Quiet by design — managed is the path nearly everyone should take.
 *
 * That key entry is a **view within this one modal**, not a modal stacked on
 * it: entering it swaps the card's header, body, and footer, and a back arrow
 * returns to the intro. Width is held constant across views so navigating
 * doesn't resize the dialog under the cursor.
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
 * Which view the card is showing: the welcome content, or the optional key
 * entry reached from it.
 */
type FirstRunView = "intro" | "byok";

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

  // One Save commits both provider forms. Each publishes its own state here;
  // the footer button derives from the pair and only the dirty ones are
  // written, so saving a key for one service doesn't touch the other.
  const [sttSave, setSttSave] = useState<ProviderFormSaveHandle | null>(null);
  const [ttsSave, setTtsSave] = useState<ProviderFormSaveHandle | null>(null);
  const keysDirty = !!sttSave?.hasChanges || !!ttsSave?.hasChanges;
  const keysSaving = !!sttSave?.saving || !!ttsSave?.saving;
  const saveKeys = async () => {
    const results = await Promise.all([
      ttsSave?.hasChanges ? ttsSave.save() : Promise.resolve(true),
      sttSave?.hasChanges ? sttSave.save() : Promise.resolve(true),
    ]);
    // Only leave on a clean save — a rejected key has to stay on screen with
    // the failure toast, not vanish behind the intro.
    if (results.every(Boolean)) {
      backToIntro();
    }
  };

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

        {view === "byok" && (
          <>
            <Modal.Header>
              <div className="flex items-center gap-2">
                <BackButton onClick={backToIntro} />
                <Modal.Title>Use your own API keys</Modal.Title>
              </div>
            </Modal.Header>
            <Modal.Body className="space-y-6">
              {/* The same forms Settings → AI renders, minus that page's card
                  chrome and its per-card Save — the footer commits both. Copy
                  matches Settings → Services so the two read as one surface. */}
              <ProviderSection
                title="Text-to-Speech"
                subtitle="Configure how your assistant speaks"
              >
                <TtsProviderForm
                  assistantId={assistantId ?? undefined}
                  hideSaveButton
                  hideCredentialsGuide
                  onSaveStateChange={setTtsSave}
                />
              </ProviderSection>
              <ProviderSection
                title="Speech-to-Text"
                subtitle="Configure how your assistant transcribes speech"
                divided
              >
                <SttProviderForm
                  assistantId={assistantId ?? undefined}
                  hideSaveButton
                  hideCredentialsGuide
                  onSaveStateChange={setSttSave}
                />
              </ProviderSection>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="primary"
                onClick={saveKeys}
                disabled={!keysDirty || keysSaving}
              >
                {keysSaving ? "Saving…" : "Save"}
              </Button>
            </Modal.Footer>
          </>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * One titled provider block in the key-entry view — the modal-scale echo of a
 * Settings → Services card, sharing its title and subtitle copy so the two
 * surfaces read as one. `divided` rules off the block from the one above it.
 */
function ProviderSection({
  title,
  subtitle,
  divided = false,
  children,
}: {
  title: string;
  subtitle: string;
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "space-y-3",
        divided && "border-t border-[var(--border-subtle)] pt-5",
      )}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-body-medium-default text-[var(--content-emphasised)]">
          {title}
        </h3>
        <p className="text-label-small-default text-[var(--content-tertiary)]">
          {subtitle}
        </p>
      </div>
      {children}
    </section>
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
