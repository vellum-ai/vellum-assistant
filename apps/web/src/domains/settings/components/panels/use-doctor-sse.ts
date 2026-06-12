/**
 * React hook managing the doctor panel SSE connection lifecycle.
 *
 * Owns the AbortController for stream cancellation. Reads/writes state
 * via the doctor panel Zustand store — no setter callbacks are needed.
 * The Zod schema and pure handlers live in sibling modules for
 * independent testability.
 */

import { useCallback, useRef } from "react";

import type { DoctorPanelContext } from "@/domains/settings/components/panels/doctor-panel-store";
import { useDoctorPanelStore } from "@/domains/settings/components/panels/doctor-panel-store";
import {
  type DoctorEvent,
  parseDoctorEvent,
} from "@/domains/settings/components/panels/doctor-event-schema";
import {
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
// Hook
// ---------------------------------------------------------------------------

const SESSION_EXPIRED_STATUSES = new Set([404, 410]);

export function useDoctorSSE() {
  const controllerRef = useRef<AbortController | null>(null);

  const connectSSE = useCallback(
    (assistantId: string, sessionId: string) => {
      const controller = new AbortController();
      controllerRef.current = controller;

      let streamEndedTerminally = false;

      const isCurrentStream = () => controllerRef.current === controller;

      const ctx: DoctorPanelContext = {
        updateEntries: (updater) => useDoctorPanelStore.getState().updateEntries(updater),
        setThinking: (v) => useDoctorPanelStore.getState().setThinking(v),
        setPendingApproval: (v) => useDoctorPanelStore.getState().setPendingApproval(v),
        setPendingBackup: (v) => useDoctorPanelStore.getState().setPendingBackup(v),
        setSessionStatus: (s) => useDoctorPanelStore.getState().setSessionStatus(s),
        appendEntry: (entry) => useDoctorPanelStore.getState().appendEntry(entry),
        nextId: () => useDoctorPanelStore.getState().nextId(),
        getStreamingEntryId: () => useDoctorPanelStore.getState().streamingEntryId,
        setStreamingEntryId: (id) => useDoctorPanelStore.getState().setStreamingEntryId(id),
      };

      const failStream = (content: string) => {
        if (!isCurrentStream()) return;
        controllerRef.current = null;
        const s = useDoctorPanelStore.getState();
        s.setThinking(false);
        s.setPendingApproval(false);
        s.setStreamingEntryId(null);
        s.setSessionStatus("error");
        s.appendEntry({ kind: "error", content });
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
            const s = useDoctorPanelStore.getState();
            s.setThinking(false);
            s.setStreamingEntryId(null);
            s.setSessionStatus("completed");
            s.setPendingApproval(false);
            s.appendEntry({
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
    [],
  );

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  return { connectSSE, abort };
}
