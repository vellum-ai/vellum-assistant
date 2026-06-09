import { useCallback, useState } from "react";

import type { ChatEntry } from "@/domains/settings/components/panels/doctor-history";
import {
  APPROVAL_RESPONSES,
  doctorBasePath,
  doctorFetch,
} from "@/domains/settings/components/panels/doctor-types";
import { assistantsMaintenanceModeExitCreate } from "@/generated/api/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";

/**
 * Parse the session_id from the doctor session creation response.
 * Returns null on malformed responses.
 */
function parseSessionId(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  return typeof obj.session_id === "string" ? obj.session_id : null;
}

const DOCTOR_GREETING =
  "Hi! I'm the Doctor. State the nature of the issue you're experiencing with your assistant and I'll help diagnose and fix it.";

interface UseDoctorSessionArgs {
  assistantId: string;
  sessionId: string | null;
  setSessionId: (id: string | null) => void;
  setSessionStatus: (s: "idle" | "active" | "completed" | "error") => void;
  appendEntry: (entry: Omit<ChatEntry, "id" | "timestamp">) => void;
  setEntries: React.Dispatch<React.SetStateAction<ChatEntry[]>>;
  setThinking: (v: boolean) => void;
  setPendingApproval: (v: boolean) => void;
  setPendingBackup: (v: boolean) => void;
  setInputValue: (v: string) => void;
  setSelectedHistorySessionId: (v: string | null) => void;
  setAppliedHistorySessionId: (v: string | null) => void;
  connectSSE: (assistantId: string, sessionId: string) => void;
  abort: () => void;
}

export function useDoctorSession(args: UseDoctorSessionArgs) {
  const {
    assistantId,
    sessionId,
    setSessionId,
    setSessionStatus,
    appendEntry,
    setEntries,
    setThinking,
    setPendingApproval,
    setPendingBackup,
    setInputValue,
    setSelectedHistorySessionId,
    setAppliedHistorySessionId,
    connectSSE,
    abort,
  } = args;

  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);

  const startSession = useCallback(async () => {
    if (!assistantId) return;
    setStarting(true);
    try {
      const response = await doctorFetch(
        `${doctorBasePath(assistantId)}/sessions/`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (response.status === 429) {
          appendEntry({
            kind: "error",
            content:
              body.error ||
              "You've used all of your available Doctor sessions for this month. Please try again next month.",
          });
          return;
        }
        appendEntry({
          kind: "error",
          content: `Failed to start session: ${body.detail || body.error || response.statusText}`,
        });
        return;
      }

      const data: unknown = await response.json();
      const sessId = parseSessionId(data);
      if (!sessId) {
        appendEntry({
          kind: "error",
          content: "Failed to start session: unexpected response format",
        });
        return;
      }

      setSelectedHistorySessionId(null);
      setAppliedHistorySessionId(null);
      setSessionId(sessId);
      setSessionStatus("active");

      // Append greeting BEFORE connecting SSE so fast events
      // don't appear above the greeting.
      setEntries([{ kind: "assistant", content: DOCTOR_GREETING, id: "greeting", timestamp: Date.now() }]);
      connectSSE(assistantId, sessId);
    } catch (error) {
      captureError(error, { context: "start_doctor_session" });
      appendEntry({ kind: "error", content: "Failed to start doctor session" });
    } finally {
      setStarting(false);
    }
  }, [
    assistantId,
    appendEntry,
    connectSSE,
    setEntries,
    setSessionId,
    setSessionStatus,
    setSelectedHistorySessionId,
    setAppliedHistorySessionId,
  ]);

  const endSession = useCallback(async () => {
    setEnding(true);
    try {
      abort();

      if (sessionId && assistantId) {
        try {
          await doctorFetch(
            `${doctorBasePath(assistantId)}/sessions/${sessionId}/`,
            { method: "DELETE" },
          );
        } catch {
          // Best effort cleanup
        }

        assistantsMaintenanceModeExitCreate({
          path: { assistant_id: assistantId },
          throwOnError: false,
        }).catch(() => {});
      }

      setSessionId(null);
      setSessionStatus("idle");
      setPendingApproval(false);
    } finally {
      setEnding(false);
    }
  }, [sessionId, assistantId, abort, setSessionId, setSessionStatus, setPendingApproval]);

  const restartSession = useCallback(async () => {
    abort();

    if (sessionId && assistantId) {
      try {
        await doctorFetch(
          `${doctorBasePath(assistantId)}/sessions/${sessionId}/`,
          { method: "DELETE" },
        );
      } catch {
        // Best effort
      }
      assistantsMaintenanceModeExitCreate({
        path: { assistant_id: assistantId },
        throwOnError: false,
      }).catch(() => {});
    }

    setSessionId(null);
    setSessionStatus("idle");
    setEntries([]);
    setPendingApproval(false);
    setPendingBackup(false);
    setSelectedHistorySessionId(null);
    setAppliedHistorySessionId(null);
  }, [
    sessionId,
    assistantId,
    abort,
    setSessionId,
    setSessionStatus,
    setEntries,
    setPendingApproval,
    setPendingBackup,
    setSelectedHistorySessionId,
    setAppliedHistorySessionId,
  ]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!sessionId || !assistantId || !content.trim()) return;
      setSending(true);

      const text = content.trim();
      appendEntry({ kind: "user", content: text });
      setInputValue("");

      if (APPROVAL_RESPONSES.has(text.toLowerCase())) {
        setPendingApproval(false);
      }

      try {
        const resp = await doctorFetch(
          `${doctorBasePath(assistantId)}/sessions/${sessionId}/messages/`,
          {
            method: "POST",
            body: JSON.stringify({ content: text }),
          },
        );
        if (!resp.ok) {
          const body: unknown = await resp.json().catch(() => ({}));
          const detail =
            body &&
            typeof body === "object" &&
            "detail" in body &&
            typeof (body as Record<string, unknown>).detail === "string"
              ? (body as Record<string, unknown>).detail
              : resp.statusText;
          appendEntry({
            kind: "error",
            content: `Failed to send message: ${detail}`,
          });
        } else {
          setThinking(true);
        }
      } catch (error) {
        captureError(error, { context: "send_doctor_message" });
        appendEntry({ kind: "error", content: "Failed to send message" });
      } finally {
        setSending(false);
      }
    },
    [sessionId, assistantId, appendEntry, setInputValue, setPendingApproval, setThinking],
  );

  return {
    sending,
    starting,
    ending,
    startSession,
    endSession,
    restartSession,
    sendMessage,
  };
}
