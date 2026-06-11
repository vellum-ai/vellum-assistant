/**
 * React hook managing the doctor panel SSE connection lifecycle.
 *
 * Owns the AbortController for stream cancellation, entry ID generation,
 * and dispatching parsed events to the appropriate handler. The Zod
 * schema and pure handlers live in sibling modules for independent
 * testability.
 */

import { useCallback, useRef } from "react";

import type { ChatEntry, NewChatEntry } from "@/domains/settings/components/panels/doctor-history";
import {
  type DoctorEvent,
  parseDoctorEvent,
} from "@/domains/settings/components/panels/doctor-event-schema";
import {
  type StreamContext,
  handleApprovalRequired,
  handleBackupPrompt,
  handleError,
  handleMessageComplete,
  handleMessageDelta,
  handleStatus,
  handleToolCall,
  handleToolResult,
} from "@/domains/settings/components/panels/doctor-event-handlers";
import { assistantsDoctorSessionsEventsRetrieve } from "@/generated/api";
import { captureError } from "@/lib/sentry/capture-error";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import { toError } from "@/utils/to-error";

// ---------------------------------------------------------------------------
// Re-exports for existing consumers
// ---------------------------------------------------------------------------

export type { DoctorEvent, StreamContext };
export { parseDoctorEvent };
export {
  handleApprovalRequired,
  handleBackupPrompt,
  handleError,
  handleMessageComplete,
  handleMessageDelta,
  handleStatus,
  handleToolCall,
  handleToolResult,
};
export { DoctorEventSchema } from "@/domains/settings/components/panels/doctor-event-schema";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const SESSION_EXPIRED_STATUSES = new Set([404, 410]);

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
              streamError = toError(error, "Doctor stream disconnected");
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
