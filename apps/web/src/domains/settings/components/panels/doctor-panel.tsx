import { ArrowUp, Loader2, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import {
  assistantsDoctorSessionsDestroy,
  assistantsMaintenanceModeExitCreate,
} from "@/generated/api/sdk.gen";
import { DoctorAvatar } from "@/domains/settings/components/panels/doctor-avatar";
import {
  type ChatEntry,
  hasPendingApproval,
  hasPendingBackup,
  mapPersistedMessagesToEntries,
  mapPersistedStatusToPanelStatus,
  selectLatestHistorySession,
} from "@/domains/settings/components/panels/doctor-history";
import { useDoctorSession } from "@/domains/settings/components/panels/use-doctor-session";
import { useDoctorSSE } from "@/domains/settings/components/panels/use-doctor-sse";
import {
  assistantsDoctorHistoryListOptions,
  assistantsDoctorHistoryRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DoctorPanel() {
  const assistantId =
    useResolvedAssistantsStore.use.activeAssistantId() ?? "";

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [pendingApproval, setPendingApproval] = useState(false);
  const [pendingBackup, setPendingBackup] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<
    "idle" | "active" | "completed" | "error"
  >("idle");
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<
    string | null
  >(null);
  const [appliedHistorySessionId, setAppliedHistorySessionId] = useState<
    string | null
  >(null);
  const [historyAutoLoadAttempted, setHistoryAutoLoadAttempted] =
    useState(false);

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
  // SSE hook
  // ---------------------------------------------------------------------------

  const { connectSSE, abort, appendEntry } = useDoctorSSE({
    setEntries,
    setThinking,
    setPendingApproval,
    setPendingBackup,
    setSessionStatus,
  });

  const {
    sending,
    starting,
    ending,
    startSession,
    endSession,
    restartSession,
    sendMessage,
  } = useDoctorSession({
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
  });

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
      setSelectedHistorySessionId(null);
      setHistoryAutoLoadAttempted(true);
      return;
    }
    const data = historyListQuery.data;
    if (!data) return;
    const latest = selectLatestHistorySession(data.results ?? []);
    setSelectedHistorySessionId(latest ? latest.id : null);
    setHistoryAutoLoadAttempted(true);
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
      setAppliedHistorySessionId(selectedHistorySessionId);
      return;
    }

    const detail = historyDetailQuery.data;
    if (!detail) return;

    const resumedEntries = mapPersistedMessagesToEntries(
      detail.messages ?? [],
    );
    setEntries(resumedEntries);
    const panelStatus = mapPersistedStatusToPanelStatus(detail.status);
    setSessionStatus(panelStatus);

    if (panelStatus === "active" && assistantId) {
      setPendingApproval(hasPendingApproval(resumedEntries));
      setPendingBackup(hasPendingBackup(resumedEntries));
      setSessionId(selectedHistorySessionId);
      connectSSE(assistantId, selectedHistorySessionId);
    }

    setAppliedHistorySessionId(selectedHistorySessionId);
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

  // Reset all doctor state when active assistant changes (e.g. user switches
  // assistant via the app-level selector while this panel is open). Without this,
  // an existing SSE stream + sessionId would remain keyed to the old assistant.
  const prevAssistantIdRef = useRef(assistantId);
  useEffect(() => {
    if (prevAssistantIdRef.current === assistantId) return;
    const oldAssistantId = prevAssistantIdRef.current;
    prevAssistantIdRef.current = assistantId;
    abort();

    // Best-effort server-side cleanup for the old session so the previous
    // assistant doesn't stay stuck in maintenance/doctor mode.
    if (sessionId && oldAssistantId) {
      assistantsDoctorSessionsDestroy({
        path: { assistant_id: oldAssistantId, session_id: sessionId },
        throwOnError: false,
      }).catch(() => {});
      assistantsMaintenanceModeExitCreate({
        path: { assistant_id: oldAssistantId },
        throwOnError: false,
      }).catch(() => {});
    }

    setEntries([]);
    setSessionId(null);
    setSessionStatus("idle");
    setThinking(false);
    setPendingApproval(false);
    setPendingBackup(false);
    setInputValue("");
    setSelectedHistorySessionId(null);
    setAppliedHistorySessionId(null);
    setHistoryAutoLoadAttempted(false);
  }, [assistantId, abort, sessionId]);

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
                            setPendingBackup(false);
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
                  setInputValue(e.target.value);
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
                onClick={restartSession}
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
