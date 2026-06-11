/**
 * Imperative session actions for the doctor panel.
 *
 * Plain async functions that read/write the doctor panel Zustand store
 * directly. Extracted from `doctor-panel.tsx` to keep the component a
 * thin render shell. Each function receives only the React-lifecycle-bound
 * dependencies it can't obtain from the module-level store (assistantId,
 * connectSSE, abort).
 */

import { useDoctorPanelStore } from "@/domains/settings/components/panels/doctor-panel-store";
import {
  assistantsDoctorSessionsCreate,
  assistantsDoctorSessionsDestroy,
  assistantsDoctorSessionsMessagesCreate,
  assistantsMaintenanceModeExitCreate,
} from "@/generated/api/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";

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
  }).catch(() => {});
  assistantsMaintenanceModeExitCreate({
    path: { assistant_id: assistantId },
    throwOnError: false,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Session actions
// ---------------------------------------------------------------------------

export async function startSession(
  assistantId: string,
  connectSSE: (assistantId: string, sessionId: string) => void,
): Promise<void> {
  if (!assistantId) return;
  const store = useDoctorPanelStore.getState();
  store.setStarting(true);
  try {
    const { data, error, response } = await assistantsDoctorSessionsCreate({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });

    if (!response?.ok || error || !data) {
      if (response?.status === 429) {
        store.appendEntry({
          kind: "error",
          content:
            "You've used all of your available Doctor sessions for this month. Please try again next month.",
        });
        return;
      }
      store.appendEntry({
        kind: "error",
        content: `Failed to start session: ${response?.statusText ?? "unknown error"}`,
      });
      return;
    }

    const sessId = data.session_id;
    store.setSelectedHistorySessionId(null);
    store.setAppliedHistorySessionId(null);
    store.setSessionId(sessId);
    store.setSessionStatus("active");
    store.setEntries([
      { kind: "assistant", content: DOCTOR_GREETING, id: "greeting", timestamp: Date.now() },
    ]);
    connectSSE(assistantId, sessId);
  } catch (err) {
    captureError(err, { context: "start_doctor_session" });
    useDoctorPanelStore.getState().appendEntry({
      kind: "error",
      content: "Failed to start doctor session",
    });
  } finally {
    useDoctorPanelStore.getState().setStarting(false);
  }
}

export async function endSession(
  assistantId: string,
  abort: () => void,
): Promise<void> {
  const store = useDoctorPanelStore.getState();
  store.setEnding(true);
  try {
    abort();
    if (store.sessionId && assistantId) {
      cleanupServerSession(assistantId, store.sessionId);
    }
    useDoctorPanelStore.getState().teardown();
  } finally {
    useDoctorPanelStore.getState().setEnding(false);
  }
}

export async function resetToIdle(
  assistantId: string,
  abort: () => void,
): Promise<void> {
  const store = useDoctorPanelStore.getState();
  abort();
  if (store.sessionId && assistantId) {
    cleanupServerSession(assistantId, store.sessionId);
  }
  useDoctorPanelStore.getState().resetForNewSession();
}

export async function sendMessage(
  assistantId: string,
  content: string,
): Promise<void> {
  const store = useDoctorPanelStore.getState();
  if (!store.sessionId || !assistantId || !content.trim()) return;
  store.setSending(true);

  const text = content.trim();
  store.appendEntry({ kind: "user", content: text });
  store.setInputValue("");

  if (APPROVAL_RESPONSES.has(text.toLowerCase())) {
    store.setPendingApproval(false);
  }

  try {
    const { error, response } = await assistantsDoctorSessionsMessagesCreate({
      path: { assistant_id: assistantId, session_id: store.sessionId },
      body: { content: text },
      throwOnError: false,
    });
    if (!response?.ok || error) {
      useDoctorPanelStore.getState().appendEntry({
        kind: "error",
        content: `Failed to send message: ${response?.statusText ?? "unknown error"}`,
      });
    } else {
      useDoctorPanelStore.getState().setThinking(true);
    }
  } catch (err) {
    captureError(err, { context: "send_doctor_message" });
    useDoctorPanelStore.getState().appendEntry({
      kind: "error",
      content: "Failed to send message",
    });
  } finally {
    useDoctorPanelStore.getState().setSending(false);
  }
}
