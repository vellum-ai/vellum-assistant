import type {
  WorkflowStartedEvent,
  WorkflowProgressEvent,
  WorkflowLeafStartedEvent,
  WorkflowLeafFinishedEvent,
  WorkflowCompletedEvent,
} from "@vellumai/assistant-api";

import { useWorkflowStore } from "@/domains/chat/workflow-store";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";

export function handleWorkflowStarted(
  event: WorkflowStartedEvent,
  _ctx: StreamHandlerContext,
): void {
  useWorkflowStore.getState().startRun({
    runId: event.runId,
    toolUseId: event.toolUseId,
    label: event.label,
    timestamp: Date.now(),
  });
}

export function handleWorkflowProgress(
  event: WorkflowProgressEvent,
  _ctx: StreamHandlerContext,
): void {
  useWorkflowStore.getState().applyProgress({
    runId: event.runId,
    phase: event.phase,
    agentsSpawned: event.agentsSpawned,
    label: event.label,
  });
}

export function handleWorkflowLeafStarted(
  event: WorkflowLeafStartedEvent,
  _ctx: StreamHandlerContext,
): void {
  useWorkflowStore.getState().leafStarted({
    runId: event.runId,
    seq: event.seq,
    label: event.label,
    promptSummary: event.promptSummary,
  });
}

export function handleWorkflowLeafFinished(
  event: WorkflowLeafFinishedEvent,
  _ctx: StreamHandlerContext,
): void {
  useWorkflowStore.getState().leafFinished({
    runId: event.runId,
    seq: event.seq,
    status: event.status,
    label: event.label,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    resultSummary: event.resultSummary,
  });
}

export function handleWorkflowCompleted(
  event: WorkflowCompletedEvent,
  _ctx: StreamHandlerContext,
): void {
  useWorkflowStore.getState().completeRun({
    runId: event.runId,
    status: event.status,
    agentsSpawned: event.agentsSpawned,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    summary: event.summary,
  });
}
