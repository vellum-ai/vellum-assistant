import type {
  AcpSessionSpawnedEvent,
  AcpSessionUpdateEvent,
  AcpSessionUsageEvent,
  AcpSessionCompletedEvent,
  AcpSessionErrorEvent,
} from "@vellumai/assistant-api";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { ACP_CLAUDE_AUTH_REQUIRED_CODE } from "@/domains/chat/utils/acp-connect";

export function handleAcpSessionSpawned(event: AcpSessionSpawnedEvent): void {
  useAcpRunStore.getState().spawnRun({
    acpSessionId: event.acpSessionId,
    agent: event.agent,
    parentConversationId: event.parentConversationId,
    parentToolUseId: event.parentToolUseId,
    task: event.task,
    startedAt: Date.now(),
  });
}

export function handleAcpSessionUpdate(event: AcpSessionUpdateEvent): void {
  const store = useAcpRunStore.getState();
  // Replay de-dupe gates only on real daemon seqs. Older assistants may omit
  // `seq`; pass those through untouched so the store appends them without
  // deduping and without advancing the high-water mark (its documented seqless
  // contract) — otherwise two seqless chunks sharing a receive timestamp would
  // collide and the second would be dropped.
  const seq = event.seq;
  if (typeof seq === "number") {
    const hwm = store.highWaterMark.get(event.acpSessionId);
    if (seq <= (hwm ?? -1)) {
      return;
    }
  }

  store.receiveEvent({
    acpSessionId: event.acpSessionId,
    event: {
      seq,
      updateType: event.updateType,
      content: event.content,
      toolCallId: event.toolCallId,
      toolTitle: event.toolTitle,
      toolKind: event.toolKind,
      toolStatus: event.toolStatus,
      // Tool-call locations[]; absent on older daemons.
      locations: event.locations,
      // Optional raw tool input/output, when the daemon forwards them.
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      messageId: event.messageId,
    },
  });
}

export function handleAcpSessionUsage(event: AcpSessionUsageEvent): void {
  useAcpRunStore.getState().updateUsage({
    acpSessionId: event.acpSessionId,
    usedTokens: event.usedTokens,
    contextSize: event.contextSize,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    costAmount: event.costAmount,
    costCurrency: event.costCurrency,
  });
}

export function handleAcpSessionCompleted(
  event: AcpSessionCompletedEvent,
): void {
  useAcpRunStore.getState().setTerminal({
    acpSessionId: event.acpSessionId,
    status: "completed",
    stopReason: event.stopReason,
    completedAt: Date.now(),
  });
}

export function handleAcpSessionError(event: AcpSessionErrorEvent): void {
  const store = useAcpRunStore.getState();
  // The daemon's cancel path rejects the in-flight prompt and emits
  // acp_session_error even though it persists the run as `cancelled`. Mirror
  // the daemon: a run already marked cancelled (by the Stop action) is not
  // regressed to `failed`.
  if (store.byId[event.acpSessionId]?.status === "cancelled") {
    return;
  }
  const entry = store.byId[event.acpSessionId];
  store.setTerminal({
    acpSessionId: event.acpSessionId,
    status: "failed",
    error: event.error,
    completedAt: Date.now(),
  });

  // The run's Claude credential was rejected. Raise the same inline Connect
  // affordance the missing-token path uses, anchored to the tool call that
  // spawned this run so it renders under that activity group. Without an
  // anchor there is nowhere to put it, so an older daemon that omitted
  // `parentToolUseId` simply keeps the plain failed-run rendering.
  //
  // Held in the interaction store rather than on the run entry for the same
  // reason as the missing-token prompt: it has to survive the routine
  // post-turn `/messages` reseed, which rebuilds the transcript from
  // persisted history.
  if (
    event.errorCode === ACP_CLAUDE_AUTH_REQUIRED_CODE &&
    entry?.parentToolUseId
  ) {
    useInteractionStore.getState().showAcpConnect({
      toolUseId: entry.parentToolUseId,
      reason: "auth_required",
    });
  }
}
