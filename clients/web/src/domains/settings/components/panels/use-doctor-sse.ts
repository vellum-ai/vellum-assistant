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
  hasPendingApproval,
  hasPendingBackup,
  isReplayableDoctorSourceEventId,
  latestReplayableDoctorSourceEventId,
  mapPersistedMessagesToEntries,
  mapPersistedStatusToPanelStatus,
  replayableDoctorSourceEventIds,
} from "@/domains/settings/components/panels/doctor-history";
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
import {
  doctorStreamTerminalMessage,
  isDoctorUnavailableStatus,
} from "@/domains/settings/components/panels/doctor-errors";
import { shouldResetDoctorSseReconnectBudget } from "@/domains/settings/components/panels/doctor-sse-reconnect";
import {
  assistantsDoctorHistoryRetrieve,
  assistantsDoctorSessionsEventsRetrieve,
} from "@/generated/api";
import type { DoctorMessage } from "@/generated/api/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { createStreamWatchdog } from "@/lib/streaming/stream-watchdog";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import { toError } from "@/utils/to-error";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const SESSION_EXPIRED_STATUSES = new Set([404, 410]);
const DOCTOR_REPLAY_GAP_CODE = "replay_gap";
const MAX_DOCTOR_SSE_RECONNECT_ATTEMPTS = 5;
const DOCTOR_SSE_RECONNECT_BASE_MS = 500;
const DOCTOR_SSE_RECONNECT_MAX_MS = 5_000;
const DOCTOR_SSE_IDLE_TIMEOUT_MS = 45_000;

function doctorReconnectDelayMs(attempt: number): number {
  const exponential = DOCTOR_SSE_RECONNECT_BASE_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(exponential, DOCTOR_SSE_RECONNECT_MAX_MS) + jitter;
}

function waitForDoctorReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

async function readDoctorReplayGap(response: Response): Promise<boolean> {
  if (response.status !== 409) {
    return false;
  }

  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;

  return body?.code === DOCTOR_REPLAY_GAP_CODE;
}

function getSseEventId(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const id = (event as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function seedDoctorPanelFromPersistedMessages(
  status: Parameters<typeof mapPersistedStatusToPanelStatus>[0],
  messages: DoctorMessage[],
): ReturnType<typeof mapPersistedStatusToPanelStatus> {
  const entries = mapPersistedMessagesToEntries(messages);
  const panelStatus = mapPersistedStatusToPanelStatus(status);
  const store = useDoctorPanelStore.getState();

  store.setEntries(entries);
  store.setSessionStatus(panelStatus);
  store.setPendingApproval(
    panelStatus === "active" && hasPendingApproval(entries),
  );
  store.setPendingBackup(panelStatus === "active" && hasPendingBackup(entries));
  store.seedReplayState(
    replayableDoctorSourceEventIds(messages),
    latestReplayableDoctorSourceEventId(messages),
  );

  return panelStatus;
}

async function refreshPersistedDoctorSession(
  assistantId: string,
  sessionId: string,
): Promise<"active" | "terminal" | null> {
  const result = await assistantsDoctorHistoryRetrieve({
    path: { assistant_id: assistantId, doctor_session_id: sessionId },
    throwOnError: false,
  });

  if (!result.response?.ok || !result.data) {
    return null;
  }

  const panelStatus = seedDoctorPanelFromPersistedMessages(
    result.data.status,
    result.data.messages ?? [],
  );

  if (panelStatus === "active") {
    useDoctorPanelStore.getState().setSessionId(sessionId);
    return "active";
  }

  return "terminal";
}

export function useDoctorSSE() {
  const controllerRef = useRef<AbortController | null>(null);

  const connectSSE = useCallback(
    (assistantId: string, sessionId: string) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      let streamEndedTerminally = false;

      const isCurrentStream = () => controllerRef.current === controller;

      const ctx: DoctorPanelContext = {
        updateEntries: (updater) =>
          useDoctorPanelStore.getState().updateEntries(updater),
        setThinking: (v) => useDoctorPanelStore.getState().setThinking(v),
        setPendingApproval: (v) =>
          useDoctorPanelStore.getState().setPendingApproval(v),
        setPendingBackup: (v) =>
          useDoctorPanelStore.getState().setPendingBackup(v),
        setSessionStatus: (s) =>
          useDoctorPanelStore.getState().setSessionStatus(s),
        appendEntry: (entry) =>
          useDoctorPanelStore.getState().appendEntry(entry),
        nextId: () => useDoctorPanelStore.getState().nextId(),
        getStreamingEntryId: () =>
          useDoctorPanelStore.getState().streamingEntryId,
        setStreamingEntryId: (id) =>
          useDoctorPanelStore.getState().setStreamingEntryId(id),
      };

      const failStream = (content: string) => {
        if (!isCurrentStream()) {
          return;
        }
        controllerRef.current = null;
        const s = useDoctorPanelStore.getState();
        s.setThinking(false);
        s.setPendingApproval(false);
        s.setPendingBackup(false);
        s.setStreamingEntryId(null);
        s.setSessionStatus("error");
        s.appendEntry({ kind: "error", content });
      };

      function dispatchEvent(event: DoctorEvent): void {
        if (!isCurrentStream()) {
          return;
        }

        const sourceEventId = event.source_event_id;
        if (isReplayableDoctorSourceEventId(sourceEventId)) {
          const shouldApply = useDoctorPanelStore
            .getState()
            .recordReplayableSourceEventId(sourceEventId);
          if (!shouldApply) {
            return;
          }
        }

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
        let reconnectAttempt = 0;
        let replayGapRefreshes = 0;

        while (!controller.signal.aborted && isCurrentStream()) {
          const attemptController = new AbortController();
          const abortAttempt = () => {
            attemptController.abort();
          };
          controller.signal.addEventListener("abort", abortAttempt, {
            once: true,
          });

          const watchdog = createStreamWatchdog({
            idleTimeoutMs: DOCTOR_SSE_IDLE_TIMEOUT_MS,
            assistantId,
          });
          watchdog.resetCounters();

          let streamError: Error | null = null;
          let sessionExpired = false;
          let replayGap = false;
          let failedStatus: number | null = null;
          let receivedDataFrame = false;
          let pendingSseEventId: string | null = null;

          try {
            const latestReplayableSourceEventId =
              useDoctorPanelStore.getState().latestReplayableSourceEventId;

            const headers: Record<string, string> = {
              Accept: "text/event-stream, application/json",
              ...getClientRegistrationHeaders(),
            };
            if (latestReplayableSourceEventId) {
              headers["Last-Event-ID"] = latestReplayableSourceEventId;
            }

            const { stream } = await assistantsDoctorSessionsEventsRetrieve({
              path: { assistant_id: assistantId, session_id: sessionId },
              headers,
              signal: attemptController.signal,
              sseMaxRetryAttempts: 0,
              fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
                const response = await globalThis.fetch(input, init);
                if (!response.ok) {
                  failedStatus = response.status;
                  if (SESSION_EXPIRED_STATUSES.has(response.status)) {
                    sessionExpired = true;
                  }
                  if (await readDoctorReplayGap(response)) {
                    replayGap = true;
                  }
                }
                return response;
              }) as typeof globalThis.fetch,
              onSseEvent: (event) => {
                const isData =
                  typeof (event as { data?: unknown }).data !== "undefined";
                if (isData) {
                  receivedDataFrame = true;
                  pendingSseEventId = getSseEventId(event);
                }
                watchdog.recordTraffic(isData);
                if (!controller.signal.aborted && isCurrentStream()) {
                  watchdog.arm(attemptController, reconnectAttempt);
                }
              },
              onSseError: (error) => {
                if (sessionExpired || replayGap) {
                  return;
                }
                streamError = toError(error, "Doctor stream disconnected");
              },
            });

            if (!isCurrentStream()) {
              return;
            }

            watchdog.arm(attemptController, reconnectAttempt);

            for await (const payload of stream) {
              if (!isCurrentStream()) {
                return;
              }

              receivedDataFrame = true;
              reconnectAttempt = 0;
              watchdog.arm(attemptController, reconnectAttempt);

              const sseEventId = pendingSseEventId;
              pendingSseEventId = null;
              const event = parseDoctorEvent(payload);
              if (event) {
                const eventWithSource =
                  event.source_event_id || !sseEventId
                    ? event
                    : { ...event, source_event_id: sseEventId };
                dispatchEvent(eventWithSource);
              }
            }
          } catch (err) {
            if (controller.signal.aborted) {
              return;
            }
            const abortCause = watchdog.consumeLastAbortCause();
            streamError =
              abortCause === "watchdog"
                ? toError(err, "Doctor stream stalled")
                : toError(err, "Doctor stream connection failed");
          } finally {
            watchdog.clear();
            controller.signal.removeEventListener("abort", abortAttempt);
          }

          if (!isCurrentStream()) {
            return;
          }

          if (streamEndedTerminally) {
            return;
          }

          if (replayGap) {
            if (replayGapRefreshes >= 1) {
              failStream(
                "Doctor event history changed while reconnecting. Start a new session to continue.",
              );
              return;
            }

            replayGapRefreshes += 1;
            let refreshed: "active" | "terminal" | null = null;
            try {
              refreshed = await refreshPersistedDoctorSession(
                assistantId,
                sessionId,
              );
            } catch (err) {
              captureError(err, { context: "doctor_replay_gap_refresh" });
            }
            if (!isCurrentStream()) {
              return;
            }
            if (refreshed === "active") {
              continue;
            }
            if (refreshed === "terminal") {
              streamEndedTerminally = true;
              return;
            }

            failStream(
              "Doctor event history changed while reconnecting. Start a new session to continue.",
            );
            return;
          }

          if (sessionExpired) {
            streamEndedTerminally = true;
            const s = useDoctorPanelStore.getState();
            s.setThinking(false);
            s.setStreamingEntryId(null);
            s.setSessionStatus("completed");
            s.setPendingApproval(false);
            s.setPendingBackup(false);
            s.appendEntry({
              kind: "status",
              content:
                "Previous session expired. Start a new session to continue.",
            });
            return;
          }

          if (!streamError) {
            streamError = new Error(
              "Doctor event stream ended before the session completed.",
            );
          }

          if (shouldResetDoctorSseReconnectBudget(receivedDataFrame)) {
            reconnectAttempt = 0;
          }

          if (reconnectAttempt >= MAX_DOCTOR_SSE_RECONNECT_ATTEMPTS) {
            if (!isDoctorUnavailableStatus(failedStatus)) {
              captureError(streamError, { context: "doctor_sse_stream" });
            }
            failStream(doctorStreamTerminalMessage(failedStatus));
            return;
          }

          await waitForDoctorReconnect(
            doctorReconnectDelayMs(reconnectAttempt),
            controller.signal,
          );
          reconnectAttempt += 1;
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
