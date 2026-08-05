import { useState } from "react";

import {
  ArrowLeft,
  AudioLines,
  Captions,
  Languages,
  MicOff,
  Settings,
} from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { SelectTriggerRow } from "@/components/speech/select-trigger-row";
import { SttLanguagePicker } from "@/components/speech/stt-language-picker";
import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { useSttLanguageSelection } from "@/components/speech/use-stt-language-selection";
import { VoiceList } from "@/components/speech/voice-list";
import { VoiceProvidersNote } from "@/components/speech/voice-providers-note";
import {
  sttLanguageLabelForCode,
  suggestedLanguageForLocale,
} from "@/lib/stt/language-catalog";
import { MANAGED_VOICE_CREDITS_NOTE } from "@/lib/tts/managed-voice-catalog";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * One-time welcome card shown the first time a user enters voice mode, before
 * the live session starts.
 *
 * Deliberately NOT a settings quiz: the preferences live in Settings → Voice
 * (the assistant's voice hot-applies from there on the next reply, so a user
 * can pick while actually hearing it), and front-loading choices
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
 * The second sanctioned exception is the listening-language row: a wrong STT
 * language is broken rather than suboptimal (the assistant would mishear every
 * turn), so it is the one default worth surfacing before the first session.
 * The row appears only where the daemon's own default leaves the user broken:
 * on locale evidence for a language that default cannot follow, only when the
 * daemon reports the configured STT provider as language-selectable, and only
 * when that provider's option set actually offers the suggested language (a
 * Tamil locale under xai has nothing valid to suggest, so no row). A Hindi
 * locale under Deepgram sees no row either, because code-switching covers
 * it, and proposing a setting that is already in effect reads as an
 * unfinished task. It is a surfaced smart default, not a question: nothing is
 * written unless the user explicitly picks, and a pick hot-applies from the
 * next spoken turn (no Save, matching the voice picker's semantics).
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
 * Which view the card is showing: the welcome content, the optional voice
 * settings reached from it, or the listening-language picker reached from
 * the intro's language row.
 */
type FirstRunView = "intro" | "settings" | "language";

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
  // The language picker is reachable from two places, so leaving it returns
  // where it was opened from rather than always to the intro. Escape and the
  // back arrow share this, so a stray keypress cannot strand someone a view
  // away from what they were doing.
  const [languageReturnView, setLanguageReturnView] =
    useState<Exclude<FirstRunView, "language">>("intro");
  const backToIntro = () => setView("intro");
  const leaveCurrentView = () =>
    setView(view === "language" ? languageReturnView : "intro");
  const openLanguage = (from: Exclude<FirstRunView, "language">) => {
    setLanguageReturnView(from);
    setView("language");
  };

  // Browser locale, read only to decide whether the intro shows a suggestion.
  // Guarded for environments without a `navigator` (the pattern
  // voice-input-button uses). The language control itself is never gated on
  // it: the setting exists for every speaker, and someone on an English
  // locale who wants a different listening language has to be able to find
  // it.
  const navigatorLanguage =
    typeof navigator !== "undefined" ? navigator.language : undefined;
  const {
    available: languageAvailable,
    currentCode: languageCode,
    configuredProviderId,
    selectLanguage,
    selecting: languageSelecting,
  } = useSttLanguageSelection(assistantId);
  // The actual suggestion is provider-scoped: null when the configured
  // provider's option set does not offer the locale's language (a Tamil
  // locale under xai), so the row never renders a suggestion the picker
  // withholds. `languageAvailable` stays false until config arrives, so the
  // row only renders once `configuredProviderId` is the real provider.
  // `languageCode` matters as much as the provider default here: a user who
  // pinned English is transcribed as English whatever unset would have meant,
  // so the row has to stay visible for them.
  const suggestedCode = suggestedLanguageForLocale(
    navigatorLanguage,
    configuredProviderId,
    languageCode,
  );

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (next) {
          return;
        }
        // Radix escape / backdrop / ✕ all route through here. In a sub-view a
        // close request means "back to the intro", mirroring `onEscapeKeyDown`
        // below; because this callback is the authoritative guard, the
        // routing holds regardless of which environment's listener fires
        // first (the document-level one and the React-tree one order
        // differently across DOM runtimes). `open` is controlled, so ignoring
        // the request costs nothing.
        if (view !== "intro") {
          leaveCurrentView();
          return;
        }
        // On the intro a close is a plain cancel: the first run stays
        // un-consumed. Inert when locked (those affordances are removed /
        // prevented below), so `onDismiss` only fires on the dismissible
        // (web) path.
        onDismiss?.();
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
                leaveCurrentView();
              }
            : nonDismissible
              ? (event) => event.preventDefault()
              : undefined
        }
        onKeyDown={
          // Belt to `onEscapeKeyDown`'s suspenders: Radix delivers Escape via
          // a document-level listener that some DOM environments never fire,
          // so the content also catches the key in the React tree; without
          // this a sub-view Escape can go entirely unhandled and the card
          // sticks. Escape in a sub-view thus has three possible paths
          // (`onOpenChange`, `onEscapeKeyDown`, this handler); any subset may
          // fire in any order, and each one routes to `backToIntro`, which is
          // a no-op when the intro is already showing, so the outcome is the
          // same whichever subset runs. A dismiss cannot slip through
          // regardless: `onOpenChange` above is the authoritative guard.
          view !== "intro"
            ? (event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  leaveCurrentView();
                }
              }
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
                  <Modal.Title className="leading-tight">
                    Voice mode
                  </Modal.Title>
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
              {/* A surfaced smart default, not a question: rendered only on
                  locale evidence for a language-selectable provider (see the
                  module docstring), and it writes nothing unless the user
                  picks. A pick hot-applies from the next spoken turn, so it
                  holds even if the card is then dismissed. */}
              {suggestedCode !== null && languageAvailable && (
                <div className="mt-5 flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2.5">
                    <Languages
                      aria-hidden
                      className="size-4 shrink-0 text-[var(--content-secondary)]"
                    />
                    <span className="text-body-medium-default">
                      Listening language
                    </span>
                  </span>
                  {/* A trigger row into the language sub-view (the card's
                      one-dialog pattern, like the Voices view), styled like
                      a compact dropdown trigger. The picker itself carries
                      the "Suggested" annotation on the locale suggestion. */}
                  <SelectTriggerRow
                    size="compact"
                    aria-label="Listening language"
                    aria-haspopup="dialog"
                    onClick={() => openLanguage("intro")}
                    value={sttLanguageLabelForCode(
                      languageCode,
                      configuredProviderId,
                    )}
                  />
                </div>
              )}
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
              {/* Start waits out an in-flight language write (mirroring the
                  Voices view's voice-write gate) so the session cannot open
                  before the picked language lands. */}
              <Button
                variant="primary"
                onClick={onStart}
                disabled={languageSelecting}
              >
                Start talking
              </Button>
            </Modal.Footer>
          </>
        )}

        {view === "settings" && (
          <VoiceSettingsView
            assistantId={assistantId}
            onStart={onStart}
            onBack={backToIntro}
            startBlocked={languageSelecting}
            languageLabel={sttLanguageLabelForCode(
              languageCode,
              configuredProviderId,
            )}
            languageAvailable={languageAvailable}
            onOpenLanguage={() => openLanguage("settings")}
          />
        )}

        {/* The listening-language sub-view: the shared search-first picker
            hosted in this one dialog (no stacked modal), mirroring the
            Voices view. A pick hot-applies and returns to the intro, whose
            Start already waits out the in-flight write; Escape and the back
            arrow return to the intro too (never a cancel). */}
        {view === "language" && (
          <>
            <Modal.Header>
              <div className="flex items-center gap-2">
                <BackButton onClick={leaveCurrentView} />
                <div className="flex min-w-0 flex-col">
                  <Modal.Title className="leading-tight">
                    Listening language
                  </Modal.Title>
                  <Modal.Description>
                    Applies from your next spoken turn.
                  </Modal.Description>
                </div>
              </div>
            </Modal.Header>
            <Modal.Body>
              <SttLanguagePicker
                currentCode={languageCode}
                configuredProviderId={configuredProviderId}
                suggestedCode={suggestedCode}
                selectLanguage={selectLanguage}
                selecting={languageSelecting}
                onDone={leaveCurrentView}
              />
            </Modal.Body>
          </>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * The "Voices" view reached from the intro's "Voice settings" link: pick the
 * assistant's voice, then start. Split into its own component so the managed-
 * voice query runs only when this view is open — not on the intro (which would
 * pull the React Query graph into every first-run render).
 */
function VoiceSettingsView({
  assistantId,
  onStart,
  onBack,
  startBlocked = false,
  languageLabel,
  languageAvailable,
  onOpenLanguage,
}: {
  assistantId: string | null;
  onStart: () => void;
  onBack: () => void;
  /** Current listening language, already labelled for its provider. */
  languageLabel: string;
  /** False for providers the daemon reports as detecting natively. */
  languageAvailable: boolean;
  /** Opens the shared language picker as a view of this same dialog. */
  onOpenLanguage: () => void;
  /**
   * An in-flight write elsewhere on the card (the intro's language pick)
   * that Start must also wait out, so the session cannot open on the
   * previous STT language regardless of which view launches it.
   */
  startBlocked?: boolean;
}) {
  // Own the selection here (rather than let the list self-commit) so the write's
  // in-flight state can gate Start: the picker reports a pick via `onChange`, and
  // `selecting` stays true until the config patch and refetch settle. Managed
  // assistants also get the credits subtitle; BYO ones see no catalog (the footer
  // note is their path), so the Vellum-credits line wouldn't apply.
  const { available, currentModel, selectModel, selecting } =
    useManagedVoiceSelection(assistantId);

  return (
    <>
      <Modal.Header>
        <div className="flex items-center gap-2">
          <BackButton onClick={onBack} />
          <div className="flex min-w-0 flex-col">
            <Modal.Title className="leading-tight">Voice settings</Modal.Title>
            {available && (
              <Modal.Description>
                {MANAGED_VOICE_CREDITS_NOTE}
              </Modal.Description>
            )}
          </div>
        </div>
      </Modal.Header>
      <Modal.Body className="flex flex-col gap-4">
        {/* The two halves of a spoken conversation, in the order they happen:
            what the assistant hears, then how it sounds back. Language leads
            because getting it wrong makes every turn wrong, where a voice is
            only ever a preference. */}
        {languageAvailable && (
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2.5">
              <Languages
                aria-hidden
                className="size-4 shrink-0 text-[var(--content-secondary)]"
              />
              <span className="text-body-medium-default">
                Listening language
              </span>
            </span>
            <SelectTriggerRow
              size="compact"
              aria-label="Listening language"
              aria-haspopup="dialog"
              onClick={onOpenLanguage}
              value={languageLabel}
            />
          </div>
        )}
        {/* The voice hot-applies on the next reply (no Save). A provider
            dropdown scopes the list; it hides itself for assistants on a
            bring-your-own provider, leaving the footer note as their path. */}
        <VoiceList
          assistantId={assistantId}
          filterBySource
          value={currentModel}
          onChange={selectModel}
        />
      </Modal.Body>
      {/* Mirrors the intro footer (fine print left, primary right) and is always
          present, so the picker flows straight into the session without a size
          change when a voice is chosen. Start waits out an in-flight voice or
          language write so the session can't open on the previous voice or
          the previous STT language. */}
      <Modal.Footer className="items-center justify-between gap-3">
        <VoiceProvidersNote />
        <Button
          variant="primary"
          onClick={onStart}
          disabled={selecting || startBlocked}
          className="shrink-0"
        >
          Start talking
        </Button>
      </Modal.Footer>
    </>
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
