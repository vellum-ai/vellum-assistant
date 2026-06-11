import { useCallback, useRef } from "react";
import { z } from "zod";

import type { ChatEntry, NewChatEntry } from "@/domains/settings/components/panels/doctor-history";
import { assistantsDoctorSessionsEventsRetrieve } from "@/generated/api";
import { captureError } from "@/lib/sentry/capture-error";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";

// ---------------------------------------------------------------------------
// SSE event protocol — Zod-validated discriminated union
// ---------------------------------------------------------------------------

export const DoctorEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), content: z.string() }),
  z.object({ type: z.literal("message_delta"), content: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    id: z.string(),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolCallId: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("approval_required"),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    id: z.string(),
    description: z.string(),
  }),
  z.object({ type: z.literal("backup_prompt"), toolName: z.string() }),
  z.object({
    type: z.literal("status"),
    status: z.union([z.literal("active"), z.literal("completed"), z.literal("error")]),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type DoctorEvent = z.infer<typeof DoctorEventSchema>;

const SESSION_EXPIRED_STATUSES = new Set([404, 410]);

export function parseDoctorEvent(payload: Record<string, unknown> | string): DoctorEvent | null {
  try {
    const obj: unknown = typeof payload === "string" ? JSON.parse(payload) : payload;
    const result = DoctorEventSchema.safeParse(obj);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
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
  ctx.setPendingBackup(false);
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
        let streamError: Error | null = null;
        let sessionExpired = false;
        let failedStatus: number | null = null;
        try {
          const { stream } = await assistantsDoctorSessionsEventsRetrieve({
            path: { assistant_id: assistantId, session_id: sessionId },
            headers: {
              Accept: "text/event-stream, application/json",
              ...getClientRegistrationHeaders(),
            },
            signal: controller.signal,
            sseMaxRetryAttempts: 0,
            fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
              const response = await globalThis.fetch(input, init);
              if (!response.ok) {
                failedStatus = response.status;
                if (SESSION_EXPIRED_STATUSES.has(response.status)) {
                  sessionExpired = true;
                }
              }
              return response;
            }) as typeof globalThis.fetch,
            onSseError: (error) => {
              if (sessionExpired) return;
              streamError =
                error instanceof Error
                  ? error
                  : new Error("Doctor stream disconnected");
            },
          });

          if (!isCurrentStream()) return;

          for await (const payload of stream) {
            if (!isCurrentStream()) return;
            const event = parseDoctorEvent(payload);
            if (event) {
              dispatchEvent(event);
            }
          }

          if (!isCurrentStream()) return;

          if (sessionExpired) {
            streamEndedTerminally = true;
            ctx.setThinking(false);
            ctx.setStreamingEntryId(null);
            ctx.setSessionStatus("completed");
            ctx.setPendingApproval(false);
            ctx.appendEntry({
              kind: "status",
              content:
                "Previous session expired. Start a new session to continue.",
            });
            return;
          }

          if (streamError) {
            captureError(streamError, { context: "doctor_sse_stream" });
            failStream(
              failedStatus
                ? `Failed to connect to event stream (${failedStatus}). Start a new session to continue.`
                : "Event stream disconnected. Start a new session to continue.",
            );
            return;
          }

          if (!streamEndedTerminally) {
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
