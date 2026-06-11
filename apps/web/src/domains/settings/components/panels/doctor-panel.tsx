import { ArrowUp, Loader2, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { ShareFeedbackModal } from "@/components/share-feedback-modal";
import {
  ApprovalBlock,
  AssistantMessage,
  BackupPromptBlock,
  ErrorMessage,
  StatusMessage,
  ToolCallBlock,
  UserMessage,
} from "@/domains/settings/components/panels/doctor-chat-blocks";
import { DoctorAvatar } from "@/domains/settings/components/panels/doctor-avatar";
import {
  hasPendingApproval,
  hasPendingBackup,
  mapPersistedMessagesToEntries,
  mapPersistedStatusToPanelStatus,
  selectLatestHistorySession,
} from "@/domains/settings/components/panels/doctor-history";
import { useDoctorPanelStore } from "@/domains/settings/components/panels/doctor-panel-store";
import { useDoctorSSE } from "@/domains/settings/components/panels/use-doctor-sse";
import {
  assistantsDoctorSessionsCreate,
  assistantsDoctorSessionsDestroy,
  assistantsDoctorSessionsMessagesCreate,
  assistantsMaintenanceModeExitCreate,
} from "@/generated/api/sdk.gen";
import {
  assistantsDoctorHistoryListOptions,
  assistantsDoctorHistoryRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire-and-forget server-side cleanup for a doctor session. */
function cleanupServerSession(assistantId: string, sessionId: string): void {
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
// Constants
// ---------------------------------------------------------------------------

const DOCTOR_GREETING =
  "Hi! I'm the Doctor. State the nature of the issue you're experiencing with your assistant and I'll help diagnose and fix it.";

const APPROVAL_RESPONSES = new Set([
  "approve",
  "approve all exec",
  "approve all future exec commands",
  "approve_all_exec",
  "deny",
]);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DoctorPanel() {
  const assistantId =
    useResolvedAssistantsStore.use.activeAssistantId() ?? "";

  // Store state (replaces 10 useState calls)
  const entries = useDoctorPanelStore.use.entries();
  const inputValue = useDoctorPanelStore.use.inputValue();
  const pendingApproval = useDoctorPanelStore.use.pendingApproval();
  const pendingBackup = useDoctorPanelStore.use.pendingBackup();
  const thinking = useDoctorPanelStore.use.thinking();
  const sessionId = useDoctorPanelStore.use.sessionId();
  const sessionStatus = useDoctorPanelStore.use.sessionStatus();
  const selectedHistorySessionId = useDoctorPanelStore.use.selectedHistorySessionId();
  const appliedHistorySessionId = useDoctorPanelStore.use.appliedHistorySessionId();
  const historyAutoLoadAttempted = useDoctorPanelStore.use.historyAutoLoadAttempted();
  const sending = useDoctorPanelStore.use.sending();
  const starting = useDoctorPanelStore.use.starting();
  const ending = useDoctorPanelStore.use.ending();

  // Local UI state (not shared with hooks)
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const platformGate = usePlatformGate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevEntryCountRef = useRef(0);
  const prevLastContentLenRef = useRef(0);

  // Scroll when entries grow (new message) OR when the last entry's content
  // grows (streaming message_delta). Avoids scrolling on tool_result in-place
  // updates to mid-array entries which don't change the tail content length.
  useEffect(() => {
    const lastContentLen = entries.at(-1)?.content.length ?? 0;
    const shouldScroll =
      entries.length > prevEntryCountRef.current ||
      lastContentLen > prevLastContentLenRef.current;
    if (shouldScroll) {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevEntryCountRef.current = entries.length;
    prevLastContentLenRef.current = lastContentLen;
  }, [entries]);

  // ---------------------------------------------------------------------------
  // SSE hook (owns only the AbortController lifecycle)
  // ---------------------------------------------------------------------------

  const { connectSSE, abort } = useDoctorSSE();

  // ---------------------------------------------------------------------------
  // Session actions (replaces useDoctorSession hook)
  // ---------------------------------------------------------------------------

  const startSession = useCallback(async () => {
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
  }, [assistantId, connectSSE]);

  const endSession = useCallback(async () => {
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
  }, [assistantId, abort]);

  const resetToIdle = useCallback(async () => {
    const store = useDoctorPanelStore.getState();
    abort();
    if (store.sessionId && assistantId) {
      cleanupServerSession(assistantId, store.sessionId);
    }
    useDoctorPanelStore.getState().resetForNewSession();
  }, [assistantId, abort]);

  const sendMessage = useCallback(
    async (content: string) => {
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
    },
    [assistantId],
  );

  // ---------------------------------------------------------------------------
  // Persisted history queries
  // ---------------------------------------------------------------------------

  const historyListEnabled =
    !!assistantId && sessionId === null && !historyAutoLoadAttempted;
  const historyListQuery = useQuery({
    ...assistantsDoctorHistoryListOptions({
      path: { assistant_id: assistantId || "placeholder" },
      query: { limit: 1 },
    }),
    enabled: historyListEnabled,
  });

  useEffect(() => {
    if (!historyListEnabled) return;
    if (historyListQuery.isError) {
      captureError(historyListQuery.error, { context: "doctor_history_list" });
      const store = useDoctorPanelStore.getState();
      store.setSelectedHistorySessionId(null);
      store.setHistoryAutoLoadAttempted(true);
      return;
    }
    const data = historyListQuery.data;
    if (!data) return;
    const latest = selectLatestHistorySession(data.results ?? []);
    const store = useDoctorPanelStore.getState();
    store.setSelectedHistorySessionId(latest ? latest.id : null);
    store.setHistoryAutoLoadAttempted(true);
  }, [
    historyListEnabled,
    historyListQuery.data,
    historyListQuery.isError,
    historyListQuery.error,
  ]);

  const historyDetailQuery = useQuery({
    ...assistantsDoctorHistoryRetrieveOptions({
      path: {
        assistant_id: assistantId || "placeholder",
        doctor_session_id: selectedHistorySessionId ?? "",
      },
    }),
    enabled:
      !!assistantId && !!selectedHistorySessionId && sessionId === null,
  });

  useEffect(() => {
    if (sessionId !== null) return;
    if (!selectedHistorySessionId) return;
    if (appliedHistorySessionId === selectedHistorySessionId) return;

    if (historyDetailQuery.isError) {
      captureError(historyDetailQuery.error, {
        context: "doctor_history_detail",
      });
      useDoctorPanelStore.getState().setAppliedHistorySessionId(selectedHistorySessionId);
      return;
    }

    const detail = historyDetailQuery.data;
    if (!detail) return;

    const store = useDoctorPanelStore.getState();
    const resumedEntries = mapPersistedMessagesToEntries(
      detail.messages ?? [],
    );
    store.setEntries(resumedEntries);
    const panelStatus = mapPersistedStatusToPanelStatus(detail.status);
    store.setSessionStatus(panelStatus);

    if (panelStatus === "active" && assistantId) {
      store.setPendingApproval(hasPendingApproval(resumedEntries));
      store.setPendingBackup(hasPendingBackup(resumedEntries));
      store.setSessionId(selectedHistorySessionId);
      connectSSE(assistantId, selectedHistorySessionId);
    }

    store.setAppliedHistorySessionId(selectedHistorySessionId);
  }, [
    sessionId,
    selectedHistorySessionId,
    appliedHistorySessionId,
    assistantId,
    connectSSE,
    historyDetailQuery.data,
    historyDetailQuery.isError,
    historyDetailQuery.error,
  ]);

  // Recover from stale active session on same-assistant remount.
  // When the component unmounts, useDoctorSSE's cleanup aborts the SSE stream,
  // but the module-level store retains sessionStatus === "active". On remount
  // with the same assistant, the assistant-change effect below skips (IDs match),
  // leaving a dead active session with no stream. Reset local state to idle.
  // Only handles same-assistant case — different-assistant remounts are handled
  // by the assistant-change effect which reads sessionId before clearing it.
  useEffect(() => {
    const store = useDoctorPanelStore.getState();
    if (
      store.lastAssistantId === assistantId &&
      store.sessionStatus === "active" &&
      store.sessionId
    ) {
      store.teardown();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: assistantId is stable at mount time
  }, []);

  // Reset all doctor state when active assistant changes (including remount
  // with a different assistant — the store is module-level and survives unmount).
  useEffect(() => {
    const store = useDoctorPanelStore.getState();
    if (store.lastAssistantId === assistantId) return;
    const oldAssistantId = store.lastAssistantId;
    const oldSessionId = store.sessionId;

    abort();
    store.reset();
    useDoctorPanelStore.setState({ lastAssistantId: assistantId });

    if (oldSessionId && oldAssistantId) {
      cleanupServerSession(oldAssistantId, oldSessionId);
    }
  }, [assistantId, abort]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      abort();
    };
  }, [abort]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const isSessionActive = sessionStatus === "active";
  const isSessionEnded =
    sessionStatus === "completed" || sessionStatus === "error";
  const isLoadingHistory =
    (assistantId && !historyAutoLoadAttempted) ||
    (selectedHistorySessionId &&
      appliedHistorySessionId !== selectedHistorySessionId);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-xl bg-[var(--surface-base)] p-5 ring-1 ring-[var(--border-base)]">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-3">
          <DoctorAvatar className="h-10 w-10 shrink-0" />
          <h2 className="text-title-small text-[var(--content-default)]">
            Doctor
          </h2>
          <Tag
            tone="neutral"
            title="Doctor is in beta — use the Settings menu to submit feedback"
          >
            Beta
          </Tag>
          {platformGate === "full" && (
            <button
              type="button"
              onClick={() => setFeedbackOpen(true)}
              className="cursor-pointer text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)]"
            >
              Share Feedback
            </button>
          )}
        </div>

        {isSessionActive && (
          <button
            type="button"
            onClick={endSession}
            disabled={ending}
            className="flex cursor-pointer items-center gap-1.5 rounded border border-[var(--system-negative-strong)] px-3 py-1.5 text-body-small-default text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Square className="h-3 w-3" />
            )}
            {ending ? "Ending\u2026" : "End Session"}
          </button>
        )}
      </div>

      {isLoadingHistory ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border-element)] border-t-[var(--content-secondary)]" />
          Loading...
        </div>
      ) : !assistantId ? (
        <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-4 py-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          <div className="flex items-center gap-2">
            <DoctorAvatar className="h-6 w-6 shrink-0" />
            <span>
              No assistant found. Hatch an assistant to use the Doctor.
            </span>
          </div>
        </div>
      ) : sessionStatus === "idle" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-12">
          <DoctorAvatar className="h-24 w-24 shrink-0" />
          <div className="text-center">
            <h3 className="text-title-medium text-[var(--content-default)]">
              Assistant Doctor
            </h3>
            <p className="mt-1 max-w-md text-body-medium-lighter text-[var(--content-tertiary)]">
              Start a diagnostic session to have the Doctor analyze your
              assistant, identify issues, and suggest or apply fixes. The Doctor
              is free to use. Doctor logs may be temporarily stored.
            </p>
          </div>
          <button
            type="button"
            onClick={startSession}
            disabled={starting}
            className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--primary-base)] px-5 py-2.5 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Start Doctor Session
          </button>
        </div>
      ) : (
        <>
          {/* Messages area */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl space-y-3">
              {entries.map((entry) => {
                switch (entry.kind) {
                  case "user":
                    return <UserMessage key={entry.id} entry={entry} />;
                  case "assistant":
                    return <AssistantMessage key={entry.id} entry={entry} />;
                  case "tool_call":
                    return (
                      <div key={entry.id} className="flex justify-start">
                        <div className="w-full">
                          <ToolCallBlock entry={entry} />
                        </div>
                      </div>
                    );
                  case "approval":
                    return (
                      <div key={entry.id} className="max-w-[90%]">
                        <ApprovalBlock
                          entry={entry}
                          onRespond={sendMessage}
                          disabled={!pendingApproval || sending}
                        />
                      </div>
                    );
                  case "backup_prompt":
                    return (
                      <div key={entry.id} className="max-w-[90%]">
                        <BackupPromptBlock
                          entry={entry}
                          onRespond={(response) => {
                            useDoctorPanelStore.getState().setPendingBackup(false);
                            sendMessage(response);
                          }}
                          disabled={!pendingBackup || sending}
                        />
                      </div>
                    );
                  case "error":
                    return <ErrorMessage key={entry.id} entry={entry} />;
                  case "status":
                    return <StatusMessage key={entry.id} entry={entry} />;
                  default:
                    return null;
                }
              })}

              {thinking && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-[5px] rounded-[var(--radius-lg)] bg-[var(--surface-overlay)] px-4 py-3">
                    {([-0.333, 0, -0.667] as const).map((delay, i) => (
                      <span
                        key={i}
                        aria-hidden
                        className="typing-dot block h-2 w-2 rounded-full bg-[var(--content-tertiary)]"
                        style={{
                          animation:
                            "typing-dot-pulse 1s ease-in-out infinite",
                          animationDelay: `${delay}s`,
                        }}
                      />
                    ))}
                    <span className="sr-only">Thinking\u2026</span>
                  </div>
                </div>
              )}

              {isSessionActive && !entries.length && (
                <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-disabled)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Connecting...
                </div>
              )}
            </div>
          </div>

          {/* Input area */}
          {isSessionActive && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (inputValue.trim() && !sending) {
                  sendMessage(inputValue);
                  if (inputRef.current) {
                    inputRef.current.style.height = "auto";
                  }
                }
              }}
              className="mx-auto w-full max-w-2xl shrink-0 overflow-hidden rounded-[10px] bg-[var(--surface-lift)] shadow-sm ring-1 ring-transparent focus-within:ring-[var(--ring)]"
            >
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => {
                  useDoctorPanelStore.getState().setInputValue(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (isPointerCoarse()) return;
                  e.preventDefault();
                  if (inputValue.trim() && !sending) {
                    sendMessage(inputValue);
                    if (inputRef.current) {
                      inputRef.current.style.height = "auto";
                    }
                  }
                }}
                placeholder={
                  pendingApproval
                    ? 'Type "approve" or "deny", or send a message...'
                    : "Type a message..."
                }
                disabled={sending}
                rows={1}
                className="w-full resize-none border-none bg-transparent px-4 pb-2 pt-3 text-body-medium-lighter text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:outline-none disabled:opacity-50"
              />
              <div className="flex items-center justify-end px-3 pb-2">
                <Button
                  variant="primary"
                  iconOnly={
                    <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                  }
                  type="submit"
                  disabled={!inputValue.trim() || sending}
                  aria-label="Send message"
                />
              </div>
            </form>
          )}

          {/* Session ended — option to restart */}
          {isSessionEnded && (
            <div className="flex shrink-0 items-center justify-center gap-3 py-2">
              <button
                type="button"
                onClick={resetToIdle}
                className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--primary-base)] px-4 py-2 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
              >
                <Play className="h-4 w-4" />
                New Session
              </button>
            </div>
          )}
        </>
      )}
      <ShareFeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        assistantId={assistantId}
      />
    </div>
  );
}
