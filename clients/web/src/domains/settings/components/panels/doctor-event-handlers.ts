/**
 * Pure event handlers for doctor SSE stream events.
 *
 * Each handler receives a {@link DoctorPanelContext} (the store's
 * state setters and ID generators) and the typed event payload, then
 * mutates panel state accordingly. Pure in the sense that they have
 * no side effects beyond calling the provided setters —
 * independently testable without React rendering.
 */

import type { DoctorPanelContext } from "@/domains/settings/components/panels/doctor-panel-store";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleMessageDelta(ctx: DoctorPanelContext, event: { content: string }): void {
  ctx.setThinking(false);
  const currentId = ctx.getStreamingEntryId();
  if (!currentId) {
    const id = ctx.nextId();
    ctx.setStreamingEntryId(id);
    ctx.updateEntries((prev) => [
      ...prev,
      { id, kind: "assistant", content: event.content, timestamp: Date.now() },
    ]);
  } else {
    ctx.updateEntries((prev) =>
      prev.map((e) =>
        e.id === currentId ? { ...e, content: e.content + event.content } : e,
      ),
    );
  }
}

export function handleMessageComplete(ctx: DoctorPanelContext): void {
  ctx.setThinking(false);
  ctx.setStreamingEntryId(null);
}

export function handleToolCall(
  ctx: DoctorPanelContext,
  event: { toolName: string; input: Record<string, unknown>; id: string },
): void {
  ctx.setThinking(false);
  ctx.setStreamingEntryId(null);
  ctx.appendEntry({
    kind: "tool_call",
    content: event.toolName,
    meta: {
      toolName: event.toolName,
      input: event.input,
      toolCallId: event.id,
      status: "running",
    },
  });
}

export function handleToolResult(
  ctx: DoctorPanelContext,
  event: { toolCallId: string; content: string; isError: boolean },
): void {
  ctx.updateEntries((prev) => {
    const idx = prev.findIndex(
      (e) => e.kind === "tool_call" && e.meta.toolCallId === event.toolCallId,
    );
    if (idx === -1) {
      return prev;
    }
    const existing = prev[idx]!;
    if (existing.kind !== "tool_call") {
      return prev;
    }
    const updated = [...prev];
    updated[idx] = {
      ...existing,
      meta: {
        ...existing.meta,
        result: event.content,
        isError: event.isError,
        status: event.isError ? "error" : "completed",
      },
    };
    return updated;
  });
}

export function handleApprovalRequired(
  ctx: DoctorPanelContext,
  event: { toolName: string; input: Record<string, unknown>; id: string; description: string },
): void {
  ctx.setThinking(false);
  ctx.setPendingApproval(true);
  ctx.appendEntry({
    kind: "approval",
    content: event.toolName,
    meta: {
      toolName: event.toolName,
      input: event.input,
      toolCallId: event.id,
      description: event.description,
    },
  });
}

export function handleBackupPrompt(ctx: DoctorPanelContext, event: { toolName: string }): void {
  ctx.setThinking(false);
  ctx.setPendingBackup(true);
  ctx.appendEntry({
    kind: "backup_prompt",
    content: event.toolName,
    meta: { toolName: event.toolName },
  });
}

export function handleFeedbackPrompt(ctx: DoctorPanelContext): void {
  if (ctx.getEntries().some((entry) => entry.kind === "feedback_prompt")) {
    return;
  }
  ctx.appendEntry({ kind: "feedback_prompt", content: "Share feedback" });
}

export function handleStatus(
  ctx: DoctorPanelContext,
  event: { status: "active" | "completed" | "error" },
): boolean {
  if (event.status === "completed" || event.status === "error") {
    ctx.setThinking(false);
    ctx.setSessionStatus(event.status);
    ctx.appendEntry({
      kind: "status",
      content:
        event.status === "completed"
          ? "Session completed"
          : "Session ended with error",
    });
    return true;
  }
  ctx.setSessionStatus(event.status);
  return false;
}

export function handleError(ctx: DoctorPanelContext, event: { message: string }): void {
  ctx.setThinking(false);
  ctx.setPendingApproval(false);
  ctx.setPendingBackup(false);
  ctx.setStreamingEntryId(null);
  ctx.appendEntry({ kind: "error", content: event.message });
}
