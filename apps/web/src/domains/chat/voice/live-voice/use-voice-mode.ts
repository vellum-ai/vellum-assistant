/**
 * `useVoiceMode()` — the voice-mode conversation loop (LUM-1969).
 *
 * Web-app counterpart to the macOS `VoiceModeManager`
 * (`clients/macos/.../VoiceModeManager.swift`). A live-voice session is
 * single-utterance (one user turn → one spoken response — see
 * {@link useLiveVoice}); voice *mode* is the persistent layer above it that
 * keeps a conversation going:
 *
 * - `off ⇄ idle` — {@link UseVoiceModeResult.activate} /
 *   {@link UseVoiceModeResult.deactivate} (button press).
 * - `idle → listening` — activation immediately opens a session.
 * - `listening → processing` — the user stops talking (automatic
 *   push-to-talk release inside the session).
 * - `processing → speaking` — first TTS chunk arrives.
 * - `speaking → listening` — the user interrupts (voice barge-in over the
 *   amplitude threshold, or the mic button via
 *   {@link UseVoiceModeResult.interrupt}): the terminated session is
 *   replaced with a fresh one attached to the same conversation.
 * - `speaking → idle → listening` — TTS completes and playback drains; the
 *   loop auto-listens for the next turn (matching the macOS auto-resume).
 *
 * The coarse mode state lives in {@link useVoiceModeStore} for UI
 * affordances and is published to the Electron main process
 * ({@link publishVoiceModeState}) so the tray can show
 * listening / thinking / speaking. Fine-grained session state (transcripts,
 * amplitude) stays in `useLiveVoiceStore`.
 *
 * ## Conversation continuity
 * The first session may create a conversation server-side; its id arrives in
 * the `ready` frame and is carried through {@link UseLiveVoiceOptions.onSessionEnd}
 * into the next session, so every turn of one voice-mode activation shares a
 * conversation.
 *
 * ## Conversation timeout
 * Listening with no recognized speech for the user's configured timeout
 * (`vellum:voice:conversationTimeoutSeconds`, default 30s — same setting the
 * Voice settings page edits) deactivates the mode, mirroring the macOS
 * conversation timeout. The store's `autoDeactivated` flag tells the UI the
 * mode ended itself.
 *
 * ## Failure handling
 * A failed session (transport error, `busy` after a barge-in reconnect, …)
 * is retried up to {@link MAX_RESTART_ATTEMPTS} times with a short delay;
 * after that the mode turns off and surfaces the live-voice error.
 */

import { useCallback, useEffect, useRef } from "react";

import {
  useLiveVoice,
  type LiveVoiceSessionEndInfo,
  type LiveVoiceSessionEndReason,
  type UseLiveVoiceOptions,
} from "@/domains/chat/voice/live-voice/use-live-voice";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  useVoiceModeStore,
  type VoiceModeState,
} from "@/domains/chat/voice/live-voice/voice-mode-store";
import { getConversationTimeoutMs } from "@/utils/voice-conversation-timeout";
import { publishVoiceModeState } from "@/runtime/voice-state";

/** Delay before retrying after a failed session while the mode is on. */
const RESTART_RETRY_DELAY_MS = 400;

/** Consecutive failed sessions tolerated before the mode gives up. */
const MAX_RESTART_ATTEMPTS = 2;

export interface UseVoiceModeOptions {
  /** Assistant whose live-voice channel the conversation runs on. */
  assistantId: string;
  /** Conversation to continue; omitted → the first session creates one. */
  conversationId?: string;
  /** Injectable live-voice primitives (tests). */
  liveVoice?: Pick<
    UseLiveVoiceOptions,
    "createClient" | "createCapture" | "createPlayer"
  >;
}

export interface UseVoiceModeResult {
  /** Coarse voice-mode state (`off`/`idle`/`listening`/`processing`/`speaking`). */
  state: VoiceModeState;
  /** Failure that ended the mode, if any (cleared on next activation). */
  error: string | null;
  /** Whether the mode turned itself off (timeout / repeated failures). */
  autoDeactivated: boolean;
  /** Smoothed mic amplitude in [0, 1] (for the button pulse). */
  inputAmplitude: number;
  /** Turn the mode on and start listening. No-op while already on. */
  activate: () => Promise<void>;
  /** Turn the mode off and end any active session. */
  deactivate: () => Promise<void>;
  /** Skip the rest of the spoken response and listen again (mid-`speaking`). */
  interrupt: () => void;
}

/**
 * Coarse mode state for a live session phase, or `null` for transient phases
 * (`ending`, `failed`) that the session-end handler resolves instead.
 */
function mapSessionStateToMode(
  sessionState: ReturnType<typeof useLiveVoiceStore.getState>["state"],
): VoiceModeState | null {
  switch (sessionState) {
    case "connecting":
    case "listening":
      return "listening";
    case "transcribing":
    case "thinking":
      return "processing";
    case "speaking":
      return "speaking";
    case "idle":
      return "idle";
    case "ending":
    case "failed":
      return null;
  }
}

export function useVoiceMode(options: UseVoiceModeOptions): UseVoiceModeResult {
  const state = useVoiceModeStore.use.state();
  const error = useVoiceModeStore.use.error();
  const autoDeactivated = useVoiceModeStore.use.autoDeactivated();

  const sessionState = useLiveVoiceStore.use.state();
  const partialTranscript = useLiveVoiceStore.use.partialTranscript();

  // Mode bookkeeping that must not re-render: whether the loop is on, the
  // conversation threading through its sessions, retry accounting, timers.
  const modeOnRef = useRef(false);
  const conversationRef = useRef<string | null>(null);
  const restartAttemptsRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current === null) return;
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
  }, []);

  /**
   * Turn the mode off locally (state, timers, flags). Ending the live
   * session is the caller's responsibility — the paths differ (user stop vs
   * already-ended session vs failure).
   */
  const turnOff = useCallback(
    (result: { auto: boolean } | { failure: string }) => {
      modeOnRef.current = false;
      clearRestartTimer();
      const store = useVoiceModeStore.getState();
      if ("failure" in result) store.fail(result.failure);
      else store.turnOff({ auto: result.auto });
    },
    [clearRestartTimer],
  );

  /**
   * Open the next session of the loop against the threaded conversation.
   * A `connect()` rejection (transport-level; server-reported failures come
   * through `onSessionEnd("failed")` instead) ends the mode with the error.
   */
  const startTurnRef = useRef<() => Promise<void>>(async () => {});

  const handleSessionEnd = useCallback(
    (reason: LiveVoiceSessionEndReason, info: LiveVoiceSessionEndInfo) => {
      if (info.conversationId) conversationRef.current = info.conversationId;
      if (!modeOnRef.current) return;

      switch (reason) {
        case "completed":
        case "interrupted":
          // The conversation loop: a finished response auto-listens for the
          // next turn; an interrupt resumes listening immediately
          // (speaking → listening).
          restartAttemptsRef.current = 0;
          void startTurnRef.current();
          break;
        case "stopped":
          // The session was stopped underneath the mode (e.g. another
          // consumer) — treat as a deactivation.
          turnOff({ auto: false });
          break;
        case "failed":
          restartAttemptsRef.current += 1;
          if (restartAttemptsRef.current <= MAX_RESTART_ATTEMPTS) {
            clearRestartTimer();
            restartTimerRef.current = setTimeout(() => {
              restartTimerRef.current = null;
              if (modeOnRef.current) void startTurnRef.current();
            }, RESTART_RETRY_DELAY_MS);
          } else {
            turnOff({
              failure:
                useLiveVoiceStore.getState().error ??
                "Voice conversation failed.",
            });
          }
          break;
      }
    },
    [clearRestartTimer, turnOff],
  );

  const live = useLiveVoice({
    ...options.liveVoice,
    onSessionEnd: handleSessionEnd,
  });

  const liveStart = live.start;
  const liveStop = live.stop;

  useEffect(() => {
    startTurnRef.current = async () => {
      if (!modeOnRef.current) return;
      try {
        await liveStart(
          optionsRef.current.assistantId,
          conversationRef.current ?? undefined,
        );
      } catch (err) {
        turnOff({
          failure:
            err instanceof Error ? err.message : "Voice conversation failed.",
        });
        await liveStop();
      }
    };
  }, [liveStart, liveStop, turnOff]);

  const activate = useCallback(async () => {
    if (modeOnRef.current) return;
    useVoiceModeStore.getState().reset();
    modeOnRef.current = true;
    restartAttemptsRef.current = 0;
    conversationRef.current = optionsRef.current.conversationId ?? null;
    useVoiceModeStore.getState().setState("idle");
    await startTurnRef.current();
  }, []);

  const deactivate = useCallback(async () => {
    if (!modeOnRef.current) return;
    turnOff({ auto: false });
    // Fires onSessionEnd("stopped"), which the handler ignores now that the
    // mode is off.
    await liveStop();
  }, [liveStop, turnOff]);

  // Project the session phase into the coarse mode state while the mode is
  // on. Terminal phases (`failed`) and gaps between sessions are resolved by
  // the session-end handler instead, so a transient `idle` between turns
  // can't flicker the UI off.
  useEffect(() => {
    if (!modeOnRef.current) return;
    const mapped = mapSessionStateToMode(sessionState);
    if (mapped !== null) useVoiceModeStore.getState().setState(mapped);
  }, [sessionState]);

  // Conversation timeout: listening with no recognized speech for the
  // configured duration deactivates the mode (auto). Recognized speech
  // (a partial transcript) or leaving `listening` clears/re-arms the timer.
  useEffect(() => {
    if (state !== "listening" || partialTranscript !== "") {
      if (idleTimeoutRef.current !== null) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      return;
    }
    const timer = setTimeout(() => {
      idleTimeoutRef.current = null;
      if (!modeOnRef.current) return;
      turnOff({ auto: true });
      void liveStop();
    }, getConversationTimeoutMs());
    idleTimeoutRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (idleTimeoutRef.current === timer) idleTimeoutRef.current = null;
    };
  }, [state, partialTranscript, liveStop, turnOff]);

  // Mirror every mode transition to the Electron main process (tray).
  useEffect(() => {
    publishVoiceModeState(state);
  }, [state]);

  // Unmount: the mode can't outlive its controller. useLiveVoice's own
  // unmount cleanup tears down the session; this resets the mode store and
  // tells main the conversation is over.
  useEffect(
    () => () => {
      modeOnRef.current = false;
      if (restartTimerRef.current !== null) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      useVoiceModeStore.getState().reset();
      publishVoiceModeState("off");
    },
    [],
  );

  return {
    state,
    error,
    autoDeactivated,
    inputAmplitude: live.inputAmplitude,
    activate,
    deactivate,
    interrupt: live.interrupt,
  };
}
