/**
 * TanStack Query mutation hooks for doctor session lifecycle.
 *
 * Each hook wraps a generated HeyAPI SDK call and handles Zustand store
 * side-effects in `onSuccess` / `onError` callbacks. Loading state
 * (`isPending`) comes from the mutation itself — no manual
 * `setSending` / `setStarting` / `setEnding` toggles needed.
 */

import { useMutation } from "@tanstack/react-query";

import { useDoctorPanelStore } from "@/domains/settings/components/panels/doctor-panel-store";
import {
  assistantsDoctorSessionsCreate,
  assistantsDoctorSessionsDestroy,
  assistantsDoctorSessionsMessagesCreate,
  assistantsMaintenanceModeExitCreate,
} from "@/generated/api/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { extractErrorMessage } from "@/utils/api-errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DOCTOR_GREETING =
  "Hi! I'm the Doctor. State the nature of the issue you're experiencing with your assistant and I'll help diagnose and fix it.";

const APPROVAL_RESPONSES = new Set([
  "approve",
  "approve all exec",
  "approve all future exec commands",
  "approve_all_exec",
  "deny",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire-and-forget server-side cleanup for a doctor session. */
export function cleanupServerSession(assistantId: string, sessionId: string): void {
  assistantsDoctorSessionsDestroy({
    path: { assistant_id: assistantId, session_id: sessionId },
    throwOnError: false,
  }).catch((err) => captureError(err, { context: "doctor_cleanup_destroy" }));
  assistantsMaintenanceModeExitCreate({
    path: { assistant_id: assistantId },
    throwOnError: false,
  }).catch((err) => captureError(err, { context: "doctor_cleanup_maintenance_exit" }));
}

/** Reset to idle for "New Session" — abort SSE, cleanup, and clear local state. */
export function resetToIdle(assistantId: string, abort: () => void): void {
  abort();
  const store = useDoctorPanelStore.getState();
  if (store.sessionId && assistantId) {
    cleanupServerSession(assistantId, store.sessionId);
  }
  store.resetForNewSession();
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useStartSession(
  assistantId: string,
  connectSSE: (assistantId: string, sessionId: string) => void,
) {
  return useMutation({
    mutationFn: async () => {
      const { data, error, response } = await assistantsDoctorSessionsCreate({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });
      if (!response?.ok || error || !data) {
        throw { error, status: response?.status, statusText: response?.statusText };
      }
      return data;
    },
    onSuccess(data) {
      const store = useDoctorPanelStore.getState();
      store.setSelectedHistorySessionId(null);
      store.setAppliedHistorySessionId(null);
      store.setSessionId(data.session_id);
      store.setSessionStatus("active");
      store.setEntries([
        { kind: "assistant", content: DOCTOR_GREETING, id: "greeting", timestamp: Date.now() },
      ]);
      connectSSE(assistantId, data.session_id);
    },
    onError(error: unknown) {
      const err = error as { status?: number; error?: unknown; statusText?: string };
      if (err.status === 429) {
        useDoctorPanelStore.getState().appendEntry({
          kind: "error",
          content:
            "You've used all of your available Doctor sessions for this month. Please try again next month.",
        });
        return;
      }
      captureError(error, { context: "start_doctor_session" });
      const message = extractErrorMessage(
        err.error,
        undefined,
        "Failed to start doctor session",
      );
      useDoctorPanelStore.getState().appendEntry({
        kind: "error",
        content: message,
      });
    },
  });
}

export function useEndSession(
  assistantId: string,
  abort: () => void,
) {
  return useMutation({
    mutationFn: async () => {
      abort();
      const store = useDoctorPanelStore.getState();
      if (store.sessionId && assistantId) {
        cleanupServerSession(assistantId, store.sessionId);
      }
      store.teardown();
    },
  });
}

export function useSendMessage(assistantId: string) {
  const sessionId = useDoctorPanelStore.use.sessionId();

  return useMutation({
    mutationFn: async (content: string) => {
      if (!sessionId) throw new Error("No active session");
      const { error, response } = await assistantsDoctorSessionsMessagesCreate({
        path: { assistant_id: assistantId, session_id: sessionId },
        body: { content },
        throwOnError: false,
      });
      if (!response?.ok || error) {
        throw { error, status: response?.status, statusText: response?.statusText };
      }
    },
    onMutate(content: string) {
      const store = useDoctorPanelStore.getState();
      store.appendEntry({ kind: "user", content });
      store.setInputValue("");

      if (APPROVAL_RESPONSES.has(content.toLowerCase())) {
        store.setPendingApproval(false);
      }
    },
    onSuccess() {
      useDoctorPanelStore.getState().setThinking(true);
    },
    onError(error: unknown) {
      captureError(error, { context: "send_doctor_message" });
      const err = error as { error?: unknown; statusText?: string };
      const message = extractErrorMessage(
        err.error,
        undefined,
        "Failed to send message",
      );
      useDoctorPanelStore.getState().appendEntry({
        kind: "error",
        content: message,
      });
    },
  });
}
