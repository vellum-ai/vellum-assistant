/**
 * Channel-setup close auto-notify.
 *
 * Stateless imperative functions — no React hooks, no component state.
 * When the user dismisses the channel setup drawer that an assistant opened
 * (`ui_show` → `open_panel`), the assistant is otherwise left waiting for the
 * user to come back to chat and type "done" before it verifies the connection.
 * The close event itself is the signal: it is forwarded to the originating
 * conversation as a hidden user message (persisted and LLM-visible, but
 * suppressed from the transcript) so the assistant proceeds immediately.
 *
 * Channel-agnostic by design — every wizard routed through the channel_setup
 * panel (Slack today; Telegram, phone, etc. later) gets the same signals.
 */

import { postChatMessage } from "@/domains/chat/api/messages";
import { resolveSupportsChannelSetupCloseNotify } from "@/lib/backwards-compat/channel-setup-close-notify";
import { captureError } from "@/lib/sentry/capture-error";
import type { ChannelSetupPayload } from "@/stores/viewer-store";

/**
 * LLM-visible marker for a dismissed channel-setup wizard. Follows the
 * daemon's synthetic-user-message convention (`[User action on <type>
 * surface: <summary>]` — see `handleSurfaceAction` in
 * `assistant/src/daemon/conversation-surfaces.ts`) so skills can key off a
 * stable, recognizable shape.
 */
export function buildChannelSetupClosedMessage(channel: string): string {
  return `[User action on channel_setup surface: closed the ${channel} setup wizard]`;
}

/**
 * LLM-visible marker for a wizard handed off to the Contacts page (phone
 * clients and narrow windows render channel setup there instead of a side
 * drawer). The Contacts flow runs standalone and cannot auto-notify on
 * completion, so this marker tells the assistant to fall back to asking the
 * user to report when they're done.
 */
export function buildChannelSetupHandedOffMessage(channel: string): string {
  return `[User action on channel_setup surface: moved the ${channel} setup to the Contacts page]`;
}

/**
 * Signal that the user dismissed the channel-setup drawer.
 *
 * Best-effort: failures are captured, never surfaced — the setup skills keep
 * a manual "tell me when you're done / ask me to check" fallback, so a lost
 * notification only means the user reports back themselves. Skips silently
 * when the payload has no originating conversation (fail closed: guessing a
 * target could wake an unrelated conversation or mint a phantom one) or when
 * the connected assistant predates end-to-end hidden-send handling.
 */
export async function notifyChannelSetupClosed(
  payload: ChannelSetupPayload,
): Promise<void> {
  await sendChannelSetupSignal(
    payload,
    buildChannelSetupClosedMessage(payload.channel),
  );
}

/**
 * Signal that the channel-setup wizard was handed off to the Contacts page
 * (the phone / narrow-viewport flow) instead of running in the side drawer.
 * Same delivery contract as {@link notifyChannelSetupClosed}.
 */
export async function notifyChannelSetupHandedOff(
  payload: ChannelSetupPayload,
): Promise<void> {
  await sendChannelSetupSignal(
    payload,
    buildChannelSetupHandedOffMessage(payload.channel),
  );
}

async function sendChannelSetupSignal(
  payload: ChannelSetupPayload,
  content: string,
): Promise<void> {
  const conversationId = payload.conversationId;
  if (!conversationId) {
    return;
  }

  try {
    if (!(await resolveSupportsChannelSetupCloseNotify())) {
      return;
    }
    const result = await postChatMessage(
      payload.assistantId,
      conversationId,
      content,
      { hidden: true },
    );
    if (!result.ok) {
      captureError(
        new Error(`channel_setup close notify rejected: HTTP ${result.status}`),
        { context: "channel_setup_close_notify" },
      );
    }
    // Deliberately no local turn-store transition. Activity for the turn
    // this wakes renders through the daemon-driven paths that cover every
    // daemon-initiated turn: `assistant_turn_start` patches the
    // conversation's `isProcessing` (stop affordance + sidebar badge) and
    // the rolling-snapshot reducer renders running tool cards from the
    // first `tool_use_start`. An optimistic local "thinking" here would
    // have no per-send recovery (no poll fallback, no reconciliation kick)
    // and could strand the UI if the stream drops in the send window.
  } catch (err) {
    captureError(err, { context: "channel_setup_close_notify" });
  }
}
