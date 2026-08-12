import { useInteractionStore } from "@/domains/chat/interaction-store";
import {
  ACP_CLAUDE_AUTH_REQUIRED_CODE,
  ACP_CLAUDE_OAUTH_MISSING_CODE,
} from "@/domains/chat/utils/acp-connect";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  ToolResultEvent,
  ToolUsePreviewStartEvent,
  ToolUseStartEvent,
} from "@vellumai/assistant-api";

/**
 * Optimistic pre-input affordance: the moment the daemon recognizes a tool call
 * (before its input finishes streaming), the rolling-snapshot reducer renders a
 * running tool card so the user sees activity immediately. The handler only
 * stamps the current-assistant anchor for subagent attribution.
 */
export function handleToolUsePreviewStart(
  event: ToolUsePreviewStartEvent,
  ctx: StreamHandlerContext,
): void {
  if (event.messageId) {
    ctx.currentAssistantMessageIdRef.current = event.messageId;
  }
}

export function handleToolUseStart(
  event: ToolUseStartEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.onToolUseStart();
  // The reducer folds the tool call onto the assistant row in the snapshot;
  // the handler owns the turn-state transition and the anchor stamp.
  if (event.messageId) {
    ctx.currentAssistantMessageIdRef.current = event.messageId;
  }
}

export function handleToolResult(
  event: ToolResultEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.onToolResult();
  // Forward structured tool activity metadata (web_search / web_fetch) onto
  // the turn store so the web-search inline link can render during the
  // active turn. Metadata is live-only — the store clears it on idle
  // transitions; the durable tool result is folded into the snapshot by the
  // reducer (which also clears any live `streamedOutput` in favor of the
  // complete `result`).
  if (event.activityMetadata && event.toolUseId) {
    ctx.turnActions.onToolActivityMetadata(
      event.toolUseId,
      event.activityMetadata,
    );
  }

  // The prompt has settled, so retire any interactive card still on screen for
  // it. The submit path already clears its own card; this covers a prompt
  // answered elsewhere (a channel option tap, a request-code reply) whose
  // answer would otherwise leave the web card open alongside the answered
  // transcript row. Guarded on the requestId so a card raised for a newer
  // question is untouched.
  if (event.answeredQuestion) {
    useInteractionStore
      .getState()
      .dismissQuestionIfMatches(event.answeredQuestion.requestId);
  }

  // A missing-token `acp_spawn` failure raises the inline "Connect Claude Code"
  // prompt in the interaction store. This is a LIVE-only tap: a `/messages`
  // reseed replays the event tail through the rolling-snapshot reducer, not
  // this handler, so the prompt is raised exactly once on live arrival. Holding
  // it in the interaction store (not on the reseed-able tool-call `errorCode`
  // field the reducer folds) is what keeps the affordance from vanishing when
  // the routine post-turn resync reseeds the transcript from persisted history.
  if (event.toolUseId) {
    if (event.errorCode === ACP_CLAUDE_OAUTH_MISSING_CODE) {
      useInteractionStore
        .getState()
        .showAcpConnect({ toolUseId: event.toolUseId });
    } else if (event.errorCode === ACP_CLAUDE_AUTH_REQUIRED_CODE) {
      // Pre-spawn rejection of a STORED credential: same card, but marked so
      // it cannot self-dismiss on a token-presence check.
      useInteractionStore.getState().showAcpConnect({
        toolUseId: event.toolUseId,
        reason: "auth_required",
      });
    }
  }
}
