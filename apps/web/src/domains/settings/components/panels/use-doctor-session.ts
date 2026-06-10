import { useCallback, useState } from "react";

import type { ChatEntry } from "@/domains/settings/components/panels/doctor-history";
import { APPROVAL_RESPONSES } from "@/domains/settings/components/panels/doctor-api";
import {
  assistantsDoctorSessionsCreate,
  assistantsDoctorSessionsDestroy,
  assistantsDoctorSessionsMessagesCreate,
  assistantsMaintenanceModeExitCreate,
} from "@/generated/api/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";

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
      const { data, error, response } = await assistantsDoctorSessionsCreate({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });

      if (!response?.ok || error || !data) {
        if (response?.status === 429) {
          appendEntry({
            kind: "error",
            content:
              "You've used all of your available Doctor sessions for this month. Please try again next month.",
          });
          return;
        }
        appendEntry({
          kind: "error",
          content: `Failed to start session: ${response?.statusText ?? "unknown error"}`,
        });
        return;
      }

      const sessId = data.session_id;
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
        assistantsDoctorSessionsDestroy({
          path: { assistant_id: assistantId, session_id: sessionId },
          throwOnError: false,
        }).catch(() => {});

        assistantsMaintenanceModeExitCreate({
          path: { assistant_id: assistantId },
          throwOnError: false,
        }).catch(() => {});
      }

      setSessionId(null);
      setSessionStatus("idle");
      setPendingApproval(false);
      setPendingBackup(false);
    } finally {
      setEnding(false);
    }
  }, [sessionId, assistantId, abort, setSessionId, setSessionStatus, setPendingApproval, setPendingBackup]);

  const restartSession = useCallback(async () => {
    abort();

    if (sessionId && assistantId) {
      assistantsDoctorSessionsDestroy({
        path: { assistant_id: assistantId, session_id: sessionId },
        throwOnError: false,
      }).catch(() => {});
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
        const { error, response } = await assistantsDoctorSessionsMessagesCreate({
          path: { assistant_id: assistantId, session_id: sessionId },
          body: { content: text },
          throwOnError: false,
        });
        if (!response?.ok || error) {
          appendEntry({
            kind: "error",
            content: `Failed to send message: ${response?.statusText ?? "unknown error"}`,
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
