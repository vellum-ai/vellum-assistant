import { dispatchOpenUrl } from "@/domains/chat/utils/oauth-popup-links";
import { getSettingsRouteForClientTab } from "@/utils/settings-navigation";
import { isSetupChannelId } from "@/types/channel-types";
import { recordDiagnostic } from "@/lib/diagnostics";
import { routes } from "@/utils/routes";
import { submitSurfaceAction } from "@/domains/chat/api/surfaces";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  NavigateSettingsEvent,
  OpenConversationEvent,
  OpenPanelEvent,
  OpenUrlEvent,
} from "@vellumai/assistant-api";

export function handleOpenUrl(
  event: OpenUrlEvent,
  ctx: StreamHandlerContext,
): void {
  const outcome = dispatchOpenUrl(event.url, {
    isNative: ctx.isNative,
    push: ctx.router.push,
  });

  if (outcome.kind === "invalid") {
    ctx.setError({
      message: "This link cannot be opened from the web app.",
    });
    return;
  }

  if (outcome.kind === "blocked") {
    // The notice's action button re-opens from a real click.
    ctx.setNotice({
      message:
        "Your browser blocked a page the assistant tried to open. Use the button to open it.",
      actionUrl: outcome.url,
    });
  }
}

/**
 * Server-directed "open this conversation" command. The event's
 * `conversationId` is the TARGET conversation (typically just created by the
 * conversation launcher), not the stream this event travelled on — the
 * conversation-id gate is bypassed by listing `open_conversation` as a global
 * stream event.
 *
 * `focus === false` means the daemon wants the conversation registered in the
 * sidebar without stealing focus from the origin. On web the sidebar list is
 * driven by the conversation-list query (refreshed via `sync_changed` when a
 * new conversation is created), so a non-focusing open needs no navigation —
 * we simply do not switch. Any other value (including the omitted default)
 * switches to and focuses the target, mirroring `navigateToConversation`.
 */
export function handleOpenConversation(
  event: OpenConversationEvent,
  ctx: StreamHandlerContext,
): void {
  if (event.focus === false) {
    return;
  }
  useViewerStore.getState().setMainView("chat");
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  useConversationStore.getState().setActiveConversationId(event.conversationId);
  ctx.router.push(routes.conversation(event.conversationId));
}

export function handleNavigateSettings(
  event: NavigateSettingsEvent,
  ctx: StreamHandlerContext,
): void {
  const route = getSettingsRouteForClientTab(event.tab);
  if (!route) {
    ctx.setError({ message: `Unknown settings tab: ${event.tab}` });
    return;
  }
  ctx.router.push(route);
}

/**
 * Report whether this client actually opened the requested panel. The daemon
 * holds the emitting `ui_show` tool call open until a client acks (or its
 * timeout elapses), so a missed or failed open surfaces as a tool error
 * instead of the model announcing a panel the user cannot see. Daemons that
 * emit `open_panel` without a `surfaceId` expect no acknowledgment.
 */
function reportOpenPanelOutcome(
  event: OpenPanelEvent,
  ctx: StreamHandlerContext,
  outcome: "ack" | "nack",
  reason?: string,
): void {
  if (!event.surfaceId) {
    return;
  }
  const assistantId = ctx.streamContext?.assistantId;
  if (!assistantId) {
    return;
  }
  void submitSurfaceAction(
    assistantId,
    event.surfaceId,
    outcome,
    reason ? { reason } : undefined,
    event.conversationId,
  );
}

export function handleOpenPanel(
  event: OpenPanelEvent,
  ctx: StreamHandlerContext,
): void {
  if (event.panelType !== "channel_setup") {
    reportOpenPanelOutcome(event, ctx, "nack", "unknown_panel_type");
    return;
  }

  const rawChannel =
    typeof event.data?.channel === "string" ? event.data.channel : undefined;
  const channel =
    rawChannel && isSetupChannelId(rawChannel) ? rawChannel : "slack";
  // The event's conversationId belongs to the assistant whose stream
  // delivered it — pair the payload with that assistant, not whatever is
  // active at arrival time, so a close-notify posted later can't mix
  // assistant A's conversation with assistant B's message endpoint (a
  // mid-switch race would otherwise 404 or mint a phantom conversation).
  const streamAssistantId = ctx.assistantId;
  if (!streamAssistantId) {
    recordDiagnostic("open_panel_failed", {
      panelType: event.panelType,
      reason: "no_active_assistant",
      conversationId: event.conversationId,
    });
    reportOpenPanelOutcome(event, ctx, "nack", "no_active_assistant");
    return;
  }
  const { assistants } = useResolvedAssistantsStore.getState();
  // The identity store carries the assistant's self-chosen name from
  // IDENTITY.md; the platform record name can be a placeholder
  // (e.g. "New Assistant"), so it is only a fallback.
  const identityName = useAssistantIdentityStore.getState().name;
  const assistantName =
    identityName?.trim() ||
    assistants.find((a) => a.id === streamAssistantId)?.name ||
    "Assistant";
  useViewerStore.getState().openChannelSetup({
    channel,
    assistantId: streamAssistantId,
    assistantName,
    conversationId: event.conversationId,
  });
  reportOpenPanelOutcome(event, ctx, "ack");
}
