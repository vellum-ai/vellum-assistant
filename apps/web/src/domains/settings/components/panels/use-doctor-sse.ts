import { useCallback, useRef } from "react";

import type { ChatEntry } from "@/domains/settings/components/panels/doctor-history";
import {
  buildDoctorSSEHeaders,
  doctorBasePath,
  parseDoctorEvent,
} from "@/domains/settings/components/panels/doctor-api";
import { captureError } from "@/lib/sentry/capture-error";

export interface DoctorSSECallbacks {
  setEntries: React.Dispatch<React.SetStateAction<ChatEntry[]>>;
  setThinking: (v: boolean) => void;
  setPendingApproval: (v: boolean) => void;
  setPendingBackup: (v: boolean) => void;
  setSessionStatus: (s: "idle" | "active" | "completed" | "error") => void;
}

/**
 * Manages the SSE connection to a doctor session. Returns `connectSSE`
 * (stable callback) and `abort` (to tear down the current stream).
 */
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
    (entry: Omit<ChatEntry, "id" | "timestamp">) => {
      setEntries((prev) => [
        ...prev,
        { ...entry, id: nextId(), timestamp: Date.now() },
      ]);
    },
    [nextId, setEntries],
  );

  const connectSSE = useCallback(
    (assistantId: string, sessionId: string) => {
      const controller = new AbortController();
      controllerRef.current = controller;

      const url = `${doctorBasePath(assistantId)}/sessions/${sessionId}/events/`;
      let streamEndedTerminally = false;

      const isCurrentStream = () => controllerRef.current === controller;

      const failStream = (content: string) => {
        if (!isCurrentStream()) return;
        controllerRef.current = null;
        setThinking(false);
        setPendingApproval(false);
        streamingEntryIdRef.current = null;
        setSessionStatus("error");
        appendEntry({ kind: "error", content });
      };

      (async () => {
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            credentials: "include",
            headers: buildDoctorSSEHeaders(),
          });

          if (!isCurrentStream()) return;

          if (!response.ok || !response.body) {
            setThinking(false);
            streamingEntryIdRef.current = null;
            if (response.status === 404 || response.status === 410) {
              streamEndedTerminally = true;
              setSessionStatus("completed");
              setPendingApproval(false);
              appendEntry({
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
                  handleEvent(event);
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

      function handleEvent(event: ReturnType<typeof parseDoctorEvent> & {}) {
        if (!isCurrentStream()) return;

        switch (event.type) {
          case "message_delta": {
            setThinking(false);
            if (!streamingEntryIdRef.current) {
              const id = nextId();
              streamingEntryIdRef.current = id;
              setEntries((prev) => [
                ...prev,
                {
                  id,
                  kind: "assistant",
                  content: event.content,
                  timestamp: Date.now(),
                },
              ]);
            } else {
              const entryId = streamingEntryIdRef.current;
              setEntries((prev) =>
                prev.map((e) =>
                  e.id === entryId
                    ? { ...e, content: e.content + event.content }
                    : e,
                ),
              );
            }
            break;
          }
          case "message":
            setThinking(false);
            streamingEntryIdRef.current = null;
            break;
          case "tool_call":
            setThinking(false);
            streamingEntryIdRef.current = null;
            appendEntry({
              kind: "tool_call",
              content: event.toolName,
              meta: {
                toolName: event.toolName,
                input: event.input,
                id: event.id,
                status: "running",
              },
            });
            break;
          case "tool_result":
            setEntries((prev) => {
              const idx = prev.findIndex(
                (e) =>
                  e.kind === "tool_call" &&
                  typeof e.meta?.id === "string" &&
                  e.meta.id === event.toolCallId,
              );
              if (idx === -1) return prev;
              const updated = [...prev];
              const existing = updated[idx]!;
              updated[idx] = {
                ...existing,
                meta: {
                  ...(existing.meta ?? {}),
                  result: event.content,
                  isError: event.isError,
                  status: event.isError ? "error" : "completed",
                },
              };
              return updated;
            });
            break;
          case "approval_required":
            setThinking(false);
            setPendingApproval(true);
            appendEntry({
              kind: "approval",
              content: event.toolName,
              meta: {
                toolName: event.toolName,
                input: event.input,
                id: event.id,
                description: event.description,
              },
            });
            break;
          case "backup_prompt":
            setThinking(false);
            setPendingBackup(true);
            appendEntry({
              kind: "backup_prompt",
              content: event.toolName,
              meta: { toolName: event.toolName },
            });
            break;
          case "status":
            if (event.status === "completed" || event.status === "error") {
              streamEndedTerminally = true;
              setThinking(false);
              setSessionStatus(event.status);
              appendEntry({
                kind: "status",
                content:
                  event.status === "completed"
                    ? "Session completed"
                    : "Session ended with error",
              });
            } else {
              setSessionStatus(event.status);
            }
            break;
          case "error":
            setThinking(false);
            setPendingApproval(false);
            streamingEntryIdRef.current = null;
            appendEntry({ kind: "error", content: event.message });
            break;
        }
      }
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
