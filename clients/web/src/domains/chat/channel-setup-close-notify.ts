/**
 * Channel-setup close auto-notify.
 *
 * Stateless imperative function — no React hooks, no component state.
 * When the user dismisses the channel setup drawer that an assistant opened
 * (`ui_show` → `open_panel`), the assistant is otherwise left waiting for the
 * user to come back to chat and type "done" before it verifies the connection.
 * The close event itself is the signal: it is forwarded to the originating
 * conversation as a hidden user message (persisted and LLM-visible, but
 * suppressed from the transcript) so the assistant proceeds immediately.
 *
 * Channel-agnostic by design — every wizard routed through the channel_setup
 * panel (Slack today; Telegram, phone, etc. later) gets the same close signal.
 */

import { postChatMessage } from "@/domains/chat/api/messages";
import { captureError } from "@/lib/sentry/capture-error";
import { useConversationStore } from "@/stores/conversation-store";
import type { ChannelSetupPayload } from "@/stores/viewer-store";

/**
 * LLM-visible marker for a dismissed channel-setup wizard. Follows the
 * daemon's synthetic-user-message convention (`[User action on <surface>
 * surface: <summary>]` — see `handleSurfaceAction` in
 * `assistant/src/daemon/conversation-surfaces.ts`) so skills can key off a
 * stable, recognizable shape.
 */
export function buildChannelSetupClosedMessage(channel: string): string {
  return `[User action on channel_setup panel: closed the ${channel} setup wizard]`;
}

/**
 * Send the wizard-closed signal for a dismissed channel-setup drawer.
 *
 * Best-effort: failures are captured, never surfaced — the skill keeps the
 * manual "ask me to check" fallback, so a lost notification only restores the
 * old behavior. Skips silently when no conversation can be resolved (the
 * drawer was opened outside a conversation context).
 */
export async function notifyChannelSetupClosed(
  payload: ChannelSetupPayload,
): Promise<void> {
  const conversationId =
    payload.conversationId ??
    useConversationStore.getState().activeConversationId;
  if (!conversationId) {
    return;
  }

  try {
    const result = await postChatMessage(
      payload.assistantId,
      conversationId,
      buildChannelSetupClosedMessage(payload.channel),
      { hidden: true },
    );
    if (!result.ok) {
      captureError(
        new Error(
          `channel_setup close notify rejected: HTTP ${result.status}`,
        ),
        { context: "channel_setup_close_notify" },
      );
    }
    // Deliberately no local turn-store transition: this path has no
    // per-send recovery (no poll fallback, no reconciliation kick), so an
    // optimistic "thinking" set here could strand the UI if SSE drops in
    // the send window. The reply is delivered like any daemon-initiated
    // turn — the SSE `assistant_turn_start`/delta events move the turn
    // store out of idle on their own, and the global reopen/watchdog
    // reconcile machinery owns catch-up after a dropped stream.
  } catch (err) {
    captureError(err, { context: "channel_setup_close_notify" });
  }
}
