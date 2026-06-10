import { useCallback, useRef } from "react";

import type { ChatEntry, NewChatEntry } from "@/domains/settings/components/panels/doctor-history";
import { buildVellumHeaders } from "@/lib/auth/request-headers";
import { captureError } from "@/lib/sentry/capture-error";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";

// ---------------------------------------------------------------------------
// SSE event protocol
// ---------------------------------------------------------------------------

export type DoctorEvent =
  | { type: "message"; content: string }
  | { type: "message_delta"; content: string }
  | {
      type: "tool_call";
      toolName: string;
      input: Record<string, unknown>;
      id: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "approval_required";
      toolName: string;
      input: Record<string, unknown>;
      id: string;
      description: string;
    }
  | { type: "backup_prompt"; toolName: string }
  | { type: "status"; status: "active" | "completed" | "error" }
  | { type: "error"; message: string };

const VALID_EVENT_TYPES = new Set([
  "message",
  "message_delta",
  "tool_call",
  "tool_result",
  "approval_required",
  "backup_prompt",
  "status",
  "error",
]);

export function parseDoctorEvent(raw: string): DoctorEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== "string" || !VALID_EVENT_TYPES.has(obj.type)) {
      return null;
    }
    return obj as unknown as DoctorEvent;
  } catch {
    return null;
  }
}

function buildSSEHeaders(): Record<string, string> {
  return buildVellumHeaders({
    Accept: "text/event-stream",
    ...getClientRegistrationHeaders(),
  });
}

// ---------------------------------------------------------------------------
// Pure event handlers
// ---------------------------------------------------------------------------

export interface StreamContext {
  setEntries: React.Dispatch<React.SetStateAction<ChatEntry[]>>;
  setThinking: (v: boolean) => void;
  setPendingApproval: (v: boolean) => void;
  setPendingBackup: (v: boolean) => void;
  setSessionStatus: (s: "idle" | "active" | "completed" | "error") => void;
  appendEntry: (entry: NewChatEntry) => void;
  nextId: () => string;
  getStreamingEntryId: () => string | null;
  setStreamingEntryId: (id: string | null) => void;
}

export function handleMessageDelta(ctx: StreamContext, event: { content: string }): void {
  ctx.setThinking(false);
  const currentId = ctx.getStreamingEntryId();
  if (!currentId) {
    const id = ctx.nextId();
    ctx.setStreamingEntryId(id);
    ctx.setEntries((prev) => [
      ...prev,
      { id, kind: "assistant", content: event.content, timestamp: Date.now() },
    ]);
  } else {
    ctx.setEntries((prev) =>
      prev.map((e) =>
        e.id === currentId ? { ...e, content: e.content + event.content } : e,
      ),
    );
  }
}

export function handleMessageComplete(ctx: StreamContext): void {
  ctx.setThinking(false);
  ctx.setStreamingEntryId(null);
}

export function handleToolCall(
  ctx: StreamContext,
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
  ctx: StreamContext,
  event: { toolCallId: string; content: string; isError: boolean },
): void {
  ctx.setEntries((prev) => {
    const idx = prev.findIndex(
      (e) => e.kind === "tool_call" && e.meta.toolCallId === event.toolCallId,
    );
    if (idx === -1) return prev;
    const existing = prev[idx]!;
    if (existing.kind !== "tool_call") return prev;
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
  ctx: StreamContext,
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

export function handleBackupPrompt(ctx: StreamContext, event: { toolName: string }): void {
  ctx.setThinking(false);
  ctx.setPendingBackup(true);
  ctx.appendEntry({
    kind: "backup_prompt",
    content: event.toolName,
    meta: { toolName: event.toolName },
  });
}

export function handleStatus(
  ctx: StreamContext,
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

export function handleError(ctx: StreamContext, event: { message: string }): void {
  ctx.setThinking(false);
  ctx.setPendingApproval(false);
  ctx.setStreamingEntryId(null);
  ctx.appendEntry({ kind: "error", content: event.message });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface DoctorSSECallbacks {
  setEntries: React.Dispatch<React.SetStateAction<ChatEntry[]>>;
  setThinking: (v: boolean) => void;
  setPendingApproval: (v: boolean) => void;
  setPendingBackup: (v: boolean) => void;
  setSessionStatus: (s: "idle" | "active" | "completed" | "error") => void;
}

export function useDoctorSSE(callbacks: DoctorSSECallbacks) {
  const {
    setEntries,
    setThinking,
    setPendingApproval,
    setPendingBackup,
    setSessionStatus,
  } = callbacks;

  const controllerRef = useRef<AbortController | null>(null);
  const streamingEntryIdRef = useRef<string | null>(null);
  const entryCounterRef = useRef(0);

  const nextId = useCallback(() => {
    return `entry-${++entryCounterRef.current}`;
  }, []);

  const appendEntry = useCallback(
    (entry: NewChatEntry) => {
      setEntries((prev) => [
        ...prev,
        { ...entry, id: nextId(), timestamp: Date.now() } as ChatEntry,
      ]);
    },
    [nextId, setEntries],
  );

  const connectSSE = useCallback(
    (assistantId: string, sessionId: string) => {
      const controller = new AbortController();
      controllerRef.current = controller;

      const url = `/v1/assistants/${assistantId}/doctor/sessions/${sessionId}/events/`;
      let streamEndedTerminally = false;

      const isCurrentStream = () => controllerRef.current === controller;

      const ctx: StreamContext = {
        setEntries,
        setThinking,
        setPendingApproval,
        setPendingBackup,
        setSessionStatus,
        appendEntry,
        nextId,
        getStreamingEntryId: () => streamingEntryIdRef.current,
        setStreamingEntryId: (id) => { streamingEntryIdRef.current = id; },
      };

      const failStream = (content: string) => {
        if (!isCurrentStream()) return;
        controllerRef.current = null;
        ctx.setThinking(false);
        ctx.setPendingApproval(false);
        ctx.setStreamingEntryId(null);
        ctx.setSessionStatus("error");
        ctx.appendEntry({ kind: "error", content });
      };

      function dispatchEvent(event: DoctorEvent): void {
        if (!isCurrentStream()) return;

        switch (event.type) {
          case "message_delta":
            handleMessageDelta(ctx, event);
            break;
          case "message":
            handleMessageComplete(ctx);
            break;
          case "tool_call":
            handleToolCall(ctx, event);
            break;
          case "tool_result":
            handleToolResult(ctx, event);
            break;
          case "approval_required":
            handleApprovalRequired(ctx, event);
            break;
          case "backup_prompt":
            handleBackupPrompt(ctx, event);
            break;
          case "status":
            if (handleStatus(ctx, event)) {
              streamEndedTerminally = true;
            }
            break;
          case "error":
            handleError(ctx, event);
            break;
        }
      }

      (async () => {
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            credentials: "include",
            headers: buildSSEHeaders(),
          });

          if (!isCurrentStream()) return;

          if (!response.ok || !response.body) {
            ctx.setThinking(false);
            ctx.setStreamingEntryId(null);
            if (response.status === 404 || response.status === 410) {
              streamEndedTerminally = true;
              ctx.setSessionStatus("completed");
              ctx.setPendingApproval(false);
              ctx.appendEntry({
                kind: "status",
                content:
                  "Previous session expired. Start a new session to continue.",
              });
            } else {
              failStream(
                `Failed to connect to event stream (${response.status})`,
              );
            }
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(":")) continue;
              if (trimmed.startsWith("data: ")) {
                const event = parseDoctorEvent(trimmed.slice(6));
                if (event) {
                  dispatchEvent(event);
                }
              }
            }
          }

          if (!controller.signal.aborted && !streamEndedTerminally) {
            failStream(
              "Doctor event stream ended before the session completed. Start a new session to continue.",
            );
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          captureError(err, { context: "doctor_sse_stream" });
          failStream(
            "Event stream disconnected. Start a new session to continue.",
          );
        }
      })();
    },
    [
      appendEntry,
      nextId,
      setEntries,
      setPendingApproval,
      setPendingBackup,
      setSessionStatus,
      setThinking,
    ],
  );

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  return { connectSSE, abort, nextId, appendEntry };
}
