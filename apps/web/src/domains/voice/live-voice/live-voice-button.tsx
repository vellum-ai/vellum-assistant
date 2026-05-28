/**
 * LiveVoiceButton — composer affordance that drives a live voice
 * conversation backed by `LiveVoiceChannelManager`.
 *
 * Renders alongside the existing `VoiceInputButton` (batch dictation):
 * both are siblings in the chat composer's icon row so users on the
 * `voice-mode` feature flag get the always-on live channel in addition
 * to push-to-talk dictation.
 *
 * The button is a thin React shell around a per-mount
 * `LiveVoiceChannelManager` instance. The manager owns the WebSocket,
 * mic capture, and PCM playback — this component just maps the current
 * `useLiveVoiceStore` state to the right icon + click handler and
 * forwards user intent to the manager. State is mirrored from the
 * `LiveVoiceChannelManager.State` enum in
 * `clients/macos/.../Features/Voice/VoiceModeManager.swift` so the web
 * and macOS surfaces stay in lockstep.
 *
 * The render is gated on the `voice-mode` assistant feature flag (auto
 * derived from the `voice-mode` registry entry) AND a non-null
 * `assistantId`. Either falsy short-circuits to `null`.
 */

import { Loader2, Mic, Phone } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

import { Button } from "@vellum/design-library";

import { LiveVoiceChannelManager } from "@/domains/voice/live-voice/live-voice-channel-manager";
import { useLiveVoiceStore } from "@/domains/voice/live-voice/live-voice-store";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Subset of `LiveVoiceChannelManager` the button drives. Pulled out so
 * tests can inject a stub without instantiating the real manager (which
 * would touch the WebSocket, mic, and Web Audio APIs at construction
 * time via its default factories).
 */
export interface LiveVoiceButtonManager {
  start(conversationId: string): Promise<void>;
  stopListening(): Promise<void>;
  interruptSpeakingAndStartListening(conversationId: string): Promise<void>;
  end(): Promise<void>;
}

export interface LiveVoiceButtonProps {
  assistantId: string | null;
  conversationId: string | null;
  disabled?: boolean;
  /**
   * Optional factory for the per-mount manager — defaults to a real
   * `LiveVoiceChannelManager`. Tests inject a stub here so they can
   * assert on the method calls without spinning up the WebSocket /
   * mic / playback stack the real manager wires up on construction.
   */
  managerFactory?: () => LiveVoiceButtonManager;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LiveVoiceButton({
  assistantId,
  conversationId,
  disabled = false,
  managerFactory,
}: LiveVoiceButtonProps) {
  const voiceModeEnabled = useAssistantFeatureFlagStore.use.voiceMode();
  const state = useLiveVoiceStore.use.state();
  const errorMessage = useLiveVoiceStore.use.errorMessage();

  const gateOpen = voiceModeEnabled && assistantId !== null;

  // `useRef` (not `useState`) so React strict-mode's double-invoke of
  // render doesn't build two managers and leak the first one's
  // WebSocket / mic handles. We only construct the manager once the
  // gate is open — for flag-off or assistantId-null mounts, leaving the
  // ref null keeps the unmount + gate-close `end()` calls no-ops so we
  // don't churn `useLiveVoiceStore` (which the manager's `end()` resets
  // via `actions().reset()`) on every disabled render.
  const managerRef = useRef<LiveVoiceButtonManager | null>(null);
  if (managerRef.current === null && gateOpen) {
    managerRef.current = managerFactory
      ? managerFactory()
      : new LiveVoiceChannelManager();
  }

  // Fire-and-forget: React's cleanup is sync, the manager's `end()` is
  // async. Dropping the promise is safe — the component has already
  // left the tree, so there's nothing to surface failures to. When the
  // gate was closed for the lifetime of this mount, `managerRef.current`
  // stays null and the cleanup is a no-op.
  useEffect(() => {
    return () => {
      void managerRef.current?.end();
    };
  }, []);

  // If the gate closes mid-session (flag flips off, assistant switches
  // and assistantId goes null), the button stops rendering — but the
  // underlying manager would silently keep the WebSocket and mic open
  // with no visible control to stop it. Tear it down on every gate
  // transition to closed so the session ends with the affordance.
  useEffect(() => {
    if (!gateOpen) {
      void managerRef.current?.end();
    }
  }, [gateOpen]);

  // The composer is stable across conversation navigation — only
  // `conversationId` changes as a prop. Without this effect, an active
  // WebSocket would keep streaming audio/STT/LLM/TTS frames against the
  // previous conversation's session while the UI shows the new one.
  // Tear down the manager when the user navigates between two real
  // conversations. Skip the initial mount (no previous id) and the
  // null→value transition (a new conversation activating for the first
  // time, not a switch).
  const previousConversationIdRef = useRef<string | null>(conversationId);
  useEffect(() => {
    const previous = previousConversationIdRef.current;
    previousConversationIdRef.current = conversationId;
    if (
      previous !== null &&
      conversationId !== null &&
      previous !== conversationId
    ) {
      void managerRef.current?.end();
    }
  }, [conversationId]);

  if (!voiceModeEnabled || !assistantId) return null;

  const manager = managerRef.current;

  // Map the live-voice state machine to (icon, click handler, label).
  // Mirrors `VoiceModeManager.stateLabel` in the macOS client so the
  // two surfaces share a vocabulary.
  let icon: ReactNode;
  let label: string;
  let onClick: () => void;
  let isBusy = false;
  let isFailed = false;

  switch (state) {
    case "off":
    case "ending":
      icon = <Phone strokeWidth={2} />;
      label = "Start voice conversation";
      onClick = () => {
        if (conversationId) {
          void manager?.start(conversationId);
        }
      };
      break;
    case "connecting":
    case "listening":
    case "transcribing":
      icon = <Mic strokeWidth={2} />;
      label =
        state === "connecting"
          ? "Connecting voice conversation"
          : "Stop voice listening";
      isBusy = state === "connecting";
      onClick = () => {
        void manager?.stopListening();
      };
      break;
    case "thinking":
    case "speaking":
      icon = <Loader2 className="animate-spin" strokeWidth={2} />;
      label = "Interrupt and resume listening";
      isBusy = true;
      onClick = () => {
        if (conversationId) {
          void manager?.interruptSpeakingAndStartListening(conversationId);
        }
      };
      break;
    case "failed":
      icon = <Phone strokeWidth={2} />;
      label = errorMessage || "Voice conversation failed — tap to retry";
      isFailed = true;
      onClick = () => {
        if (!conversationId) return;
        // Chain `end → start` so the second call lands after teardown;
        // the manager builds fresh collaborators on each `start()` so
        // they don't fight over the failed session's stale WebSocket.
        void (async () => {
          await manager?.end();
          await manager?.start(conversationId);
        })();
      };
      break;
  }

  return (
    <Button
      // `dangerGhost` paints the negative tokens across light/dark/velvet
      // themes — needed for the failed-state red icon.
      variant={isFailed ? "dangerGhost" : "ghost"}
      iconOnly={icon}
      onClick={onClick}
      disabled={disabled || !conversationId}
      aria-label={label}
      aria-busy={isBusy}
      title={label}
      // Match `VoiceInputButton`'s secondary tint so the two composer
      // icons sit at the same visual weight.
      className={isFailed ? undefined : "[--vbtn-fg:var(--content-secondary)]"}
    />
  );
}
