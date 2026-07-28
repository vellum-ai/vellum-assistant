/**
 * Title-bar pill for an active live-voice session (Light 54's right cluster).
 * Presentational — the mounting host owns store wiring and visibility rules.
 *
 * Two forms, split at the `md` breakpoint, because the header has room for a
 * control cluster on a desktop window and none on a phone:
 *
 * - **Desktop** — mic glyph (mute toggle), the voice room's listening waves
 *   in a compact strip, red ✕ (end session), and the stop slot: a circular ■
 *   that appears only while the assistant is `speaking` and the host provides
 *   `onStop`.
 * - **Mobile** — one `AudioLines` glyph, accent-tinted to read as the live
 *   session, opening a `BottomSheet` carrying the same actions as rows (mute,
 *   stop while speaking, go to thread, end). This is the repo's standard
 *   dropdown-on-desktop / sheet-on-mobile pattern; see
 *   `conversation-actions-menu.tsx`.
 *
 * Both forms are textless: the mic glyph and the animating waves carry "a
 * voice session is live and listening" on their own, and a phone-width header
 * has no room for a label beside the centre title. The state string reaches
 * assistive tech through an `sr-only` live region instead, so the session
 * state is never visual-only.
 *
 * On desktop the wave strip is the pill's largest target and carries the
 * return-to-thread tap. It is a `button` only when `onNavigate` is supplied —
 * a session not yet attached to a conversation has nowhere to go — so it
 * never ships a dead target; mobile applies the same rule by omitting the
 * sheet's navigate row.
 *
 * Mute is one tap deeper on mobile than on desktop. The invariant a hot mic
 * must hold is a *visible* control, which the trigger itself satisfies; a
 * one-tap toggle would cost the centre title more room than the header has.
 *
 * Neither form offers a manual "send now". Turns release themselves — server
 * VAD in hands-free, auto-release in the manual fallback — so a persistent
 * primary send affordance would advertise an action the user never needs to
 * take. ■ (barge-in) earns its place because interrupting a reply in progress
 * has no silent equivalent.
 *
 * The pill lives inside `ChatLayoutHeader`, which doubles as the Electron
 * macOS title bar (`-webkit-app-region: drag`). The root opts the whole
 * cluster out via `no-drag` so every child — including the non-`button`
 * canvas area — stays clickable, matching the header's own treatment of its
 * interactive children.
 *
 * Height is capped at `h-8` (32px): the header's Electron title-bar row is
 * 44px min-height with 32px controls, so the pill must never stretch it.
 */

import { useState, type CSSProperties } from "react";

import {
  AudioLines,
  CornerUpRight,
  Mic,
  MicOff,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";

import { BottomSheet, Button, Tag, cn } from "@vellumai/design-library";

import { buildPanelMenuItem } from "@/domains/chat/components/panel-menu-item";
import {
  isLiveVoiceMicLive,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  VOICE_WAVE_EDGE_FADE_CLASS,
  VoiceListeningWaves,
} from "@/domains/chat/voice/voice-room/voice-listening-waves";
import { AVATAR_ACCENT_CSS_VAR } from "@/hooks/use-avatar-accent-var";
import { useIsMobile } from "@/hooks/use-is-mobile";

// While the mic is not live (muted, assistant speaking) the waves read a
// steady zero and settle into their quiet drift — the room's own resting
// listening band — instead of freezing.
const SILENT_AMPLITUDE = () => 0;

export interface VoiceSessionPillProps {
  /**
   * The session's activity label (e.g. "Listening…" — see
   * `LIVE_VOICE_STATE_LABELS`). Not painted: announced to assistive tech
   * through an `sr-only` live region, since the pill itself is textless.
   */
  primaryLabel: string;
  state: LiveVoiceSessionState;
  /** Polled by the waveform at ~30 Hz; must not force parent re-renders. */
  getAmplitude: () => number;
  /** Whether the mic is muted — drives the mic toggle beside the waveform. */
  muted: boolean;
  /** Toggle the mic mute without ending the session. */
  onToggleMute: () => void;
  /**
   * Stop the in-flight assistant response without ending the session. The
   * ■ control occupies the stop slot only while `speaking`, and is hidden
   * when absent — the host wires it only for hands-free sessions, where the
   * interrupt is turn-scoped; a manual session's interrupt ends the whole
   * session, so there the ✕ (`onEnd`) is the only stop.
   */
  onStop?: () => void;
  /** End the voice session. */
  onEnd: () => void;
  /**
   * Navigate to the owning thread. Turns the wave strip into the tap target;
   * omitted when the session has no conversation to return to, leaving the
   * waves inert rather than a dead button.
   */
  onNavigate?: () => void;
  /**
   * Accent hex matching the avatar the voice room renders (see
   * `resolveWaveAccentHex`), so the pill's waves keep the room's tint.
   * Null/omitted falls back to the app-wide accent, then aurora.
   */
  waveAccentHex?: string | null;
}

export function VoiceSessionPill({
  primaryLabel,
  state,
  getAmplitude,
  muted,
  onToggleMute,
  onStop,
  onEnd,
  onNavigate,
  waveAccentHex,
}: VoiceSessionPillProps) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The room's listening-wave band in a compact strip: needs a positioned box
  // to fill (the component is absolutely positioned) and overflow-hidden so
  // the drifting layers clip to it.
  const waves = (
    <VoiceListeningWaves
      getAmplitude={
        isLiveVoiceMicLive(state) && !muted ? getAmplitude : SILENT_AMPLITUDE
      }
      palette="accent"
      placement="inline"
    />
  );
  const waveStripClass = cn(
    "relative h-4 w-24 overflow-hidden",
    VOICE_WAVE_EDGE_FADE_CLASS,
  );
  const waveStripStyle = waveAccentHex
    ? ({ [AVATAR_ACCENT_CSS_VAR]: waveAccentHex } as CSSProperties)
    : undefined;

  // Phones collapse the whole cluster into one glyph. The expanded row needs
  // ~160pt (mic + 96pt waves + ✕); on a 402pt phone the header's three zones
  // share 338pt, which leaves the centre title less than the ~62pt "New Chat"
  // occupies — narrower still once a conversation carries an assets chip. A
  // single 32pt trigger keeps the title readable.
  if (isMobile) {
    const close = () => setSheetOpen(false);
    return (
      <div
        role="group"
        aria-label="Voice session"
        className="flex h-8 items-center [-webkit-app-region:no-drag]"
      >
        <span aria-live="polite" className="sr-only">
          {muted ? "Muted" : primaryLabel}
        </span>
        <BottomSheet.Root open={sheetOpen} onOpenChange={setSheetOpen}>
          <BottomSheet.Trigger asChild>
            <Button
              variant="ghost"
              iconOnly={
                muted ? (
                  <MicOff className="size-4" />
                ) : (
                  <AudioLines className="size-4" />
                )
              }
              // `expandOnMobile` keeps its default `true` here (the desktop
              // form opts out): it supplies the `touch-mobile` 40px circular
              // chrome that matches the search and notification buttons this
              // trigger sits beside.
              aria-label="Voice session controls"
              // Tinted to the room's avatar accent so the glyph reads as the
              // live session rather than a generic header button; muted
              // overrides it with the negative tone, matching the mic toggle.
              // Inline, so it wins over the variant's `touch-mobile` fg.
              className={
                muted ? "[--vbtn-fg:var(--system-negative-strong)]" : undefined
              }
              style={
                !muted && waveAccentHex
                  ? ({ "--vbtn-fg": waveAccentHex } as CSSProperties)
                  : undefined
              }
            />
          </BottomSheet.Trigger>
          <BottomSheet.Content aria-describedby={undefined}>
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>Voice session</BottomSheet.Title>
            </BottomSheet.Header>
            <BottomSheet.Body className="pt-0">
              {buildPanelMenuItem({
                key: "mute",
                icon: muted ? Mic : MicOff,
                label: muted ? "Unmute microphone" : "Mute microphone",
                run: onToggleMute,
                onClose: close,
              })}
              {onStop && state === "speaking"
                ? buildPanelMenuItem({
                    key: "stop",
                    icon: Square,
                    label: "Stop response",
                    run: onStop,
                    onClose: close,
                  })
                : null}
              {onNavigate
                ? buildPanelMenuItem({
                    key: "navigate",
                    icon: CornerUpRight,
                    label: "Go to voice session thread",
                    run: onNavigate,
                    onClose: close,
                  })
                : null}
              {buildPanelMenuItem({
                key: "end",
                icon: X,
                label: "End voice session",
                className: "text-[var(--system-negative-strong)]",
                run: onEnd,
                onClose: close,
              })}
            </BottomSheet.Body>
          </BottomSheet.Content>
        </BottomSheet.Root>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Voice session"
      className="flex h-8 items-center gap-2 [-webkit-app-region:no-drag]"
    >
      {/* The pill paints no text, so the session state reaches assistive tech
          here instead. Announced on change, like the composer bar's label. */}
      <span aria-live="polite" className="sr-only">
        {muted ? "Muted" : primaryLabel}
      </span>
      <div className="flex items-center gap-1">
        {/* The mic glyph doubles as the mute toggle — the one control a hot
            open mic must always offer, wherever the session surface is. */}
        <Button
          variant="ghost"
          iconOnly={
            muted ? (
              <MicOff className="size-3.5" />
            ) : (
              <Mic className="size-3.5" />
            )
          }
          expandOnMobile={false}
          onClick={onToggleMute}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          tooltip={muted ? "Unmute microphone" : "Mute microphone"}
          className={
            muted ? "[--vbtn-fg:var(--system-negative-strong)]" : undefined
          }
        />
        {/* The waves are the pill's largest target, so they carry the
            return-to-thread tap — a `button` only when there is a thread to
            return to. */}
        {onNavigate ? (
          <button
            type="button"
            onClick={onNavigate}
            aria-label="Go to voice session thread"
            className={cn(waveStripClass, "cursor-pointer")}
            style={waveStripStyle}
          >
            {waves}
          </button>
        ) : (
          <div className={waveStripClass} style={waveStripStyle}>
            {waves}
          </div>
        )}
      </div>
      <Button
        variant="danger"
        iconOnly={<X strokeWidth={2.5} />}
        className="rounded-full"
        expandOnMobile={false}
        aria-label="End voice session"
        tooltip="End voice session"
        onClick={onEnd}
      />
      {/* Stop slot: ■ interrupts a reply in progress, and is present only
          while one is playing — nothing occupies the slot otherwise, which is
          what keeps the resting pill to four compact controls.
          `expandOnMobile={false}` keeps desktop sizing so the pill never
          exceeds the header row height on touch-mobile web. */}
      {onStop && state === "speaking" ? (
        <Button
          variant="primary"
          iconOnly={<Square fill="currentColor" />}
          className="rounded-full"
          expandOnMobile={false}
          aria-label="Stop assistant response"
          tooltip="Stop assistant response"
          onClick={onStop}
        />
      ) : null}
    </div>
  );
}

export interface VoiceSessionErrorChipProps {
  /** Failure message from the live-voice store (`error` when `failed`). */
  message: string;
  /** Dismiss the failure (host resets the store back to idle). */
  onDismiss: () => void;
}

/**
 * Compact failed-session chip rendered in the pill's slot when a session
 * fails while no composer (and thus no composer failure `Notice`) is on
 * screen — Home, Library, the inspector, the fullscreen app viewer. Composes
 * the design-library `Tag` in its dismissible-chip form (negative tone,
 * `onRemove`), overriding only what the title-bar slot demands: the pill's
 * `h-8` height budget, pill radius, a subtle negative border, and the
 * Electron `no-drag` opt-out.
 */
export function VoiceSessionErrorChip({
  message,
  onDismiss,
}: VoiceSessionErrorChipProps) {
  return (
    <Tag
      role="alert"
      tone="negative"
      leftIcon={<TriangleAlert />}
      onRemove={onDismiss}
      removeLabel="Dismiss"
      className="h-8 max-w-80 gap-2 rounded-full border border-[color-mix(in_srgb,var(--system-negative-strong)_25%,transparent)] py-1 pl-3 pr-1.5 [-webkit-app-region:no-drag]"
    >
      <span className="min-w-0 truncate" title={message}>
        {message}
      </span>
    </Tag>
  );
}
