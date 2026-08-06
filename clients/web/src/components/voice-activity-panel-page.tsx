import {
  Brain,
  Check,
  CornerUpLeft,
  Mic,
  MicOff,
  MessageSquareText,
  PhoneOff,
  RadioTower,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  activateVoiceActivityApp,
  getVoiceActivityState,
  sendVoiceActivityControl,
  setVoiceActivityCollapsed,
  subscribeVoiceActivityState,
} from "@/runtime/desktop-voice-activity";
import type {
  VoiceActivityControlAction,
  VoiceActivityPhase,
  VoiceActivityState,
} from "@/runtime/is-electron";

/**
 * The floating live-voice session surface, rendered inside the Electron window
 * the main process shows for the length of a session
 * (`clients/macos/src/main/voice-activity-window.ts`).
 *
 * The desktop counterpart to the iOS Lock Screen card, and deliberately the
 * same handful of facts: identity (avatar and assistant name), the phase as
 * both a glyph and passed-through wording, how long the call has been running,
 * the turn's activity line, and the session's controls. Where the island has
 * four sizes to drop facts between, this has one (a panel the user placed
 * themselves), so nothing is dropped.
 *
 * Two rules carried over from `VoiceSessionIslandViews.swift`, for the same
 * reasons:
 *
 * 1. **No phase copy of its own.** Every string describing the session is
 *    `label` or `assistantName`, passed through from the session's own store.
 *    `LIVE_VOICE_STATE_LABELS` / `liveVoiceSurfaceLabel` own the wording. This
 *    page happens to ship in the same bundle as that store today, but the
 *    payload it renders is a bridge contract shared with a native shell, and a
 *    surface that re-words its own phases is how the two come to disagree.
 * 2. **Accent is decoration, never the carrier.** `accentHex` is the user's
 *    avatar color and can be any brightness, over a vibrancy material sampling
 *    an unknown desktop. Text stays on the theme's own content tokens, which
 *    adapt; the accent only fills shapes.
 *
 * Standalone (no auth, no RootLayout) like the dictation overlay and Quick
 * Input. The window canvas is transparent with a vibrancy material behind it,
 * and that material is the background. The page adds only what the material
 * cannot draw for itself, a hairline border and a specular highlight along the
 * top edge; a wash of its own would double-tint the glass, which is what made
 * the first build read as a flat translucent rectangle. Off-Electron the
 * subscription no-ops and the page stays blank.
 */
export function VoiceActivityPanelPage() {
  const [state, setState] = useState<VoiceActivityState | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeVoiceActivityState(setState);
    // This route chunk loads lazily after the window is created, so the
    // session's first states can be pushed before the subscription above
    // registers and be dropped. Pull the latest to catch up: pushed states
    // are newer, so never overwrite one.
    void getVoiceActivityState().then((initial) => {
      if (initial) {
        setState((current) => current ?? initial);
      }
    });
    return unsubscribe;
  }, []);

  if (!state) {
    return null;
  }

  const pendingApproval = state.approvalRequestId !== "";
  const surfaceStyle = {
    ["--voice-accent" as string]: accentColor(state.accentHex),
  };

  // Shrunk out of the way: identity, phase and elapsed time, which is what is
  // still worth knowing at a glance. The avatar restores it, so the chip needs
  // no chrome of its own.
  if (state.collapsed) {
    return (
      <div
        className="relative flex h-screen w-screen items-center gap-2 overflow-hidden rounded-full border border-white/15 px-2 [-webkit-app-region:drag] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/40 before:to-transparent"
        style={surfaceStyle}
      >
        <button
          type="button"
          aria-label="Expand voice panel"
          title="Expand"
          className="shrink-0 rounded-full [-webkit-app-region:no-drag] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--voice-accent)]"
          onClick={() => {
            setVoiceActivityCollapsed(false);
          }}
        >
          <Identity
            assistantName={state.assistantName}
            avatarBase64={state.avatarBase64}
          />
        </button>
        <PhaseGlyph phase={state.phase} />
        <Elapsed startedAt={state.startedAt} />
      </div>
    );
  }

  return (
    // The surface drags; every control opts out. The macOS traffic lights are
    // the window's controls, so the page draws none of its own.
    <div
      className="relative flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-white/15 [-webkit-app-region:drag] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/40 before:to-transparent"
      style={surfaceStyle}
    >
      {/* Identity titles the window, centered over the traffic lights rather
          than sharing a row with the session's state. Who is on the call is the
          one fact here that never changes, so it reads as the window's name;
          everything that moves lives below. */}
      <div className="relative flex h-[34px] shrink-0 items-center justify-center gap-1.5">
        <Identity
          assistantName={state.assistantName}
          avatarBase64={state.avatarBase64}
        />
        <span className="max-w-[150px] truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--content-primary)]">
          {state.assistantName}
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-2 px-3.5 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <PhaseGlyph phase={state.phase} />
          <span className="min-w-0 truncate text-[12px] text-[var(--content-secondary)]">
            {state.label}
          </span>
          <Elapsed startedAt={state.startedAt} />
        </div>

        {state.detail !== "" && (
          <span className="min-w-0 truncate text-[11px] text-[var(--content-tertiary)]">
            {state.detail}
          </span>
        )}

        {pendingApproval ? (
          <ApprovalControls requestId={state.approvalRequestId} />
        ) : (
          <SessionControls
            muted={state.muted}
            outputMuted={state.outputMuted}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The phase as a glyph.
 *
 * **A glyph is not copy, which is why this may switch on `phase` when nothing
 * else here may.** The rule above exists because wording deploys continuously
 * while a native shell ships on release cadence; a symbol has no second source
 * to drift from, and the phase vocabulary itself is the contract: a new phase
 * makes this switch a compile error.
 *
 * It earns its place by being legible at a glance from across a desk, which
 * an 11px caption is not: someone who has put this panel in a screen corner
 * reads its state peripherally, and the glyph is what survives that.
 *
 * Matches `phaseSymbol` in `VoiceSessionIslandViews.swift` one-for-one. Known
 * corner: a `speaking` phase that has gone silent mid-turn relabels to
 * "Thinking…" via `liveVoiceSurfaceLabel` while `phase` stays `speaking`, so
 * the glyph reads as a speaker beside that word. The island has the same seam
 * and it is not fixable on one surface alone. The daemon's APNs path composes
 * the island's content from the raw phase, so remapping here would leave the
 * two drivers disagreeing.
 */
function PhaseGlyph({ phase }: { phase: VoiceActivityPhase }) {
  const className = "size-3.5 shrink-0 text-[var(--voice-accent)]";
  switch (phase) {
    case "connecting":
      return <RadioTower className={className} aria-hidden />;
    case "listening":
      return <Mic className={className} aria-hidden />;
    case "transcribing":
      return <MessageSquareText className={className} aria-hidden />;
    case "thinking":
      return <Brain className={className} aria-hidden />;
    case "speaking":
      return <Volume2 className={className} aria-hidden />;
    case "ending":
      return <PhoneOff className={className} aria-hidden />;
  }
}

/**
 * The avatar, or the accent as a plain disc when there is none small enough to
 * have crossed the bridge.
 *
 * The bytes arrive base64 without their type, so the data URL's is read back
 * off the payload's own magic prefix. `<img>` would very likely sniff its way
 * to the right decoder regardless, but "very likely" is not a thing to build
 * an identity on.
 */
function Identity({
  assistantName,
  avatarBase64,
}: {
  assistantName: string;
  avatarBase64?: string;
}) {
  if (avatarBase64 === undefined) {
    return (
      <span
        className="size-5 shrink-0 rounded-full bg-[var(--voice-accent)]"
        aria-hidden
      />
    );
  }
  const mime = avatarBase64.startsWith("/9j/") ? "image/jpeg" : "image/png";
  return (
    <img
      src={`data:${mime};base64,${avatarBase64}`}
      alt={assistantName}
      className="size-5 shrink-0 rounded-full object-cover"
    />
  );
}

/**
 * Elapsed call time, ticking from the timestamp the main process stamped.
 *
 * Anchored in main rather than here because this renderer can reload or be
 * recreated mid-session, and a clock anchored in it would restart when that
 * happened, the one fact on the panel a user would read as "the call dropped
 * and came back".
 */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const label = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-[var(--content-secondary)]">
      {label}
    </span>
  );
}

/**
 * Mute the mic, mute the assistant, end the call.
 *
 * **Each mute sends the state its own label promised, not a toggle.** The
 * panel renders content that can be a beat behind the session, so a toggle
 * resolved against live state would be self-consistent and still wrong for the
 * user: a button reading "Mute assistant" over an already-muted session would
 * unmute it. Sending what the button said makes a stale press a no-op that the
 * next push corrects. See `VoiceActivityControl` in the IPC contract.
 */
function SessionControls({
  muted,
  outputMuted,
}: {
  muted: boolean;
  outputMuted: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <ControlButton
        action={muted ? "unmuteMicrophone" : "muteMicrophone"}
        label={muted ? "Unmute microphone" : "Mute microphone"}
      >
        {muted ? (
          <MicOff className="size-3.5" aria-hidden />
        ) : (
          <Mic className="size-3.5" aria-hidden />
        )}
      </ControlButton>
      <ControlButton
        action={outputMuted ? "unmuteAssistantAudio" : "muteAssistantAudio"}
        label={outputMuted ? "Unmute assistant" : "Mute assistant"}
      >
        {outputMuted ? (
          <VolumeX className="size-3.5" aria-hidden />
        ) : (
          <Volume2 className="size-3.5" aria-hidden />
        )}
      </ControlButton>
      {/* Back to the conversation, the desktop reading of the island's
          tap-through and of the pill's tappable middle. A button rather than
          the surface itself: the background is the drag handle, and a region
          cannot both drag and be clicked. */}
      <button
        type="button"
        aria-label="Return to conversation"
        title="Return to conversation"
        className="ml-auto flex h-6 items-center justify-center rounded-md px-2 text-[var(--content-secondary)] transition-colors [-webkit-app-region:no-drag] hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--voice-accent)]"
        onClick={activateVoiceActivityApp}
      >
        <CornerUpLeft className="size-3.5" aria-hidden />
      </button>

      {/* The room's own end control, at panel scale: the same ✕ at the same
          weight, in the same destructive tone, under the same label. Ending a
          call is the one irreversible thing on this surface, so it should look
          identical wherever the user meets it. */}
      <ControlButton
        action="endSession"
        label="End voice session"
        className="text-[var(--system-negative-strong)]"
      >
        <X className="size-3.5" strokeWidth={2.5} aria-hidden />
      </ControlButton>
    </div>
  );
}

/**
 * Approve or deny the confirmation the turn is blocked on.
 *
 * Takes the controls' place rather than crowding in beside them: the turn is
 * stopped until this is answered, so it is the only thing on the panel worth
 * pressing, and a 300pt row that tried to carry five buttons would make each
 * of them a smaller target than the decision deserves.
 *
 * The request id travels with the press so the session answers the question
 * the user was actually shown. See `VoiceActivityControl.requestId`.
 */
function ApprovalControls({ requestId }: { requestId: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <ControlButton
        action="approveRequest"
        requestId={requestId}
        label="Approve"
        className="flex-1 text-[var(--system-positive-strong)]"
      >
        <Check className="size-3.5" aria-hidden />
        <span className="text-[11px] font-medium">Allow</span>
      </ControlButton>
      <ControlButton
        action="denyRequest"
        requestId={requestId}
        label="Deny"
        className="flex-1 text-[var(--system-negative-strong)]"
      >
        <X className="size-3.5" aria-hidden />
        <span className="text-[11px] font-medium">Deny</span>
      </ControlButton>
    </div>
  );
}

function ControlButton({
  action,
  requestId,
  label,
  className = "",
  children,
}: {
  action: VoiceActivityControlAction;
  requestId?: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`flex h-6 items-center justify-center gap-1 rounded-md px-2 text-[var(--content-secondary)] transition-colors [-webkit-app-region:no-drag] hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--voice-accent)] ${className}`}
      onClick={() => {
        sendVoiceActivityControl(
          requestId === undefined ? { action } : { action, requestId },
        );
      }}
    >
      {children}
    </button>
  );
}

/**
 * The accent to paint glyphs and focus rings with.
 *
 * `accentHex` is `""` while the avatar is still resolving, and the contract
 * makes no promise it parses, so anything that isn't an obvious `#RRGGBB`
 * falls back to the theme's own accent rather than being handed to CSS, where
 * an invalid value would silently drop the custom property and take the
 * glyph's color with it.
 */
function accentColor(accentHex: string): string {
  return /^#[0-9a-f]{6}$/i.test(accentHex)
    ? accentHex
    : "var(--content-secondary)";
}
