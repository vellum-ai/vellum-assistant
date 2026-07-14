import { ArrowUp, Check, ChevronDown, ClipboardCopy, Loader2, Play, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { ShareFeedbackModal } from "@/components/share-feedback-modal";
import type { FeedbackReason } from "@/components/share-feedback-types";
import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import {
  ApprovalBlock,
  AssistantMessage,
  BackupPromptBlock,
  ErrorMessage,
  FeedbackPromptBlock,
  UserOutcomePromptBlock,
  StatusMessage,
  ToolCallBlock,
  UserMessage,
} from "@/domains/settings/components/panels/doctor-chat-blocks";
import { DoctorAvatar } from "@/domains/settings/components/panels/doctor-avatar";
import {
  type ChatEntry,
  type DoctorUserOutcomeAnswer,
  applySessionUserOutcome,
  hasPendingApproval,
  hasPendingBackup,
  latestReplayableDoctorSourceEventId,
  mapPersistedMessagesToEntries,
  mapPersistedStatusToPanelStatus,
  replayableDoctorSourceEventIds,
  selectLatestHistorySession,
  serializeSessionToText,
} from "@/domains/settings/components/panels/doctor-history";
import { useDoctorPanelStore } from "@/domains/settings/components/panels/doctor-panel-store";
import {
  APPROVAL_RESPONSES,
  DOCTOR_GREETING,
  cleanupServerSession,
} from "@/domains/settings/components/panels/doctor-session-actions";
import { useDoctorSSE } from "@/domains/settings/components/panels/use-doctor-sse";
import { useDoctorAutoScroll } from "@/domains/settings/components/panels/use-doctor-auto-scroll";
import {
  assistantsDoctorHistoryListOptions,
  assistantsDoctorHistoryRetrieveOptions,
  useAssistantsDoctorSessionsMessagesCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import {
  type Options,
  assistantsDoctorSessionsCreate,
  assistantsDoctorSessionsUserOutcomeCreate,
} from "@/generated/api/sdk.gen";
import type { AssistantsDoctorSessionsCreateData } from "@/generated/api/types.gen";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { ApiError, extractErrorMessage } from "@/utils/api-errors";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// CopySessionButton
// ---------------------------------------------------------------------------

function CopySessionButton({ entries }: { entries: ChatEntry[] }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(() => {
    const text = serializeSessionToText(entries);
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, 1500);
      })
      .catch(() => {});
  }, [entries]);

  return (
    <Button
      variant="ghost"
      size="compact"
      leftIcon={
        copied ? (
          <Check className="text-[var(--system-positive-strong)]" />
        ) : (
          <ClipboardCopy />
        )
      }
      onClick={handleCopy}
      tooltip={copied ? "Copied!" : "Copy session to clipboard"}
      aria-label={copied ? "Copied" : "Copy session to clipboard"}
    >
      {copied ? "Copied!" : "Copy Session"}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DoctorPanel() {
  const assistantId =
    useResolvedAssistantsStore.use.activeAssistantId() ?? "";

  // Store state — client-owned values only
  const storeEntries = useDoctorPanelStore.use.entries();
  const inputValue = useDoctorPanelStore.use.inputValue();
  const pendingApproval = useDoctorPanelStore.use.pendingApproval();
  const pendingBackup = useDoctorPanelStore.use.pendingBackup();
  const thinking = useDoctorPanelStore.use.thinking();
  const sessionId = useDoctorPanelStore.use.sessionId();
  const storeSessionStatus = useDoctorPanelStore.use.sessionStatus();
  const historyDismissed = useDoctorPanelStore.use.historyDismissed();

  // Local UI state
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState<{
    message?: string;
    reason?: FeedbackReason;
  } | null>(null);

  const platformGate = usePlatformGate();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ---------------------------------------------------------------------------
  // SSE hook (owns only the AbortController lifecycle)
  // ---------------------------------------------------------------------------

  const { connectSSE, abort } = useDoctorSSE();

  // ---------------------------------------------------------------------------
  // History queries — server-owned data read from query cache, not store
  // ---------------------------------------------------------------------------

  const historyListEnabled =
    !!assistantId && sessionId === null && !historyDismissed && storeEntries.length === 0;

  const historyListQuery = useQuery({
    ...assistantsDoctorHistoryListOptions({
      path: { assistant_id: assistantId || "placeholder" },
      query: { limit: 1 },
    }),
    enabled: historyListEnabled,
  });

  const latestHistorySession = historyListQuery.data
    ? selectLatestHistorySession(historyListQuery.data.results ?? [])
    : null;
  const latestHistorySessionId = latestHistorySession?.id ?? null;

  const historyDetailQuery = useQuery({
    ...assistantsDoctorHistoryRetrieveOptions({
      path: {
        assistant_id: assistantId || "placeholder",
        doctor_session_id: latestHistorySessionId ?? "",
      },
    }),
    enabled:
      !!assistantId && !!latestHistorySessionId && !historyDismissed && sessionId === null && storeEntries.length === 0,
  });

  // Derive history entries from query cache (no store copy for completed sessions).
  // When historyDismissed is true, treat cache as empty so the UI shows idle state.
  const historyDetail = historyDismissed ? undefined : historyDetailQuery.data;
  const historyStatus = historyDetail
    ? mapPersistedStatusToPanelStatus(historyDetail.status)
    : null;
  const historyEntries = useMemo(
    () =>
      historyDetail
        ? applySessionUserOutcome(
            mapPersistedMessagesToEntries(historyDetail.messages ?? []),
            historyDetail.user_outcome,
          )
        : [],
    [historyDetail],
  );

  // Resume active session from history — one-time mode transition into active mode.
  // This is NOT "copying server state to client state" — it's seeding the store
  // with the initial entries before SSE takes over appending new ones.
  useEffect(() => {
    if (historyDismissed) {
      return;
    }
    if (sessionId !== null) {
      return;
    }
    if (storeEntries.length > 0) {
      return;
    }
    if (!historyDetail || !latestHistorySessionId) {
      return;
    }
    if (historyStatus !== "active") {
      return;
    }

    const store = useDoctorPanelStore.getState();
    const messages = historyDetail.messages ?? [];
    const resumedEntries = applySessionUserOutcome(
      mapPersistedMessagesToEntries(messages),
      historyDetail.user_outcome,
    );
    store.setEntries(resumedEntries);
    store.setPendingApproval(hasPendingApproval(resumedEntries));
    store.setPendingBackup(hasPendingBackup(resumedEntries));
    store.seedReplayState(
      replayableDoctorSourceEventIds(messages),
      latestReplayableDoctorSourceEventId(messages),
    );
    store.setSessionId(latestHistorySessionId);
    store.setSessionStatus("active");
    connectSSE(assistantId, latestHistorySessionId);
  }, [
    historyDismissed,
    sessionId,
    storeEntries.length,
    historyDetail,
    historyStatus,
    latestHistorySessionId,
    assistantId,
    connectSSE,
  ]);

  // Capture query errors for observability
  useEffect(() => {
    if (historyListQuery.error) {
      captureError(historyListQuery.error, { context: "doctor_history_list" });
    }
  }, [historyListQuery.error]);

  useEffect(() => {
    if (historyDetailQuery.error) {
      captureError(historyDetailQuery.error, { context: "doctor_history_detail" });
    }
  }, [historyDetailQuery.error]);

  // ---------------------------------------------------------------------------
  // Generated mutation hooks — used directly, no wrappers
  // ---------------------------------------------------------------------------

  // Custom mutationFn so we can inspect response.status for 429 rate-limit
  // handling. The generated useAssistantsDoctorSessionsCreateMutation hook
  // uses throwOnError which discards the HTTP status from the thrown error.
  const startMutation = useMutation({
    async mutationFn(options: Options<AssistantsDoctorSessionsCreateData>) {
      const { data, error, response } = await assistantsDoctorSessionsCreate({
        ...options,
        throwOnError: false,
      });
      if (error) {
        if (response?.status === 429) {
          throw new ApiError(
            429,
            "You've used all of your available Doctor sessions for this month. Please try again next month.",
          );
        }
        throw error;
      }
      return data!;
    },
    onSuccess(data) {
      const store = useDoctorPanelStore.getState();
      store.resetReplayState();
      store.setSessionId(data.session_id);
      store.setSessionStatus("active");
      store.setEntries([
        { kind: "assistant", content: DOCTOR_GREETING, id: "greeting", timestamp: Date.now() },
      ]);
      connectSSE(assistantId, data.session_id);
    },
    onError(error) {
      if (!(error instanceof ApiError && error.status === 429)) {
        captureError(error, { context: "start_doctor_session" });
      }
      const store = useDoctorPanelStore.getState();
      store.setSessionStatus("error");
      store.appendEntry({
        kind: "error",
        content: error instanceof ApiError
          ? error.message
          : extractErrorMessage(error, undefined, "Failed to start doctor session"),
      });
    },
  });

  const sendMutation = useAssistantsDoctorSessionsMessagesCreateMutation({
    onMutate(variables) {
      const content = variables.body.content;
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
    onError(error) {
      captureError(error, { context: "send_doctor_message" });
      useDoctorPanelStore.getState().appendEntry({
        kind: "error",
        content: extractErrorMessage(error, undefined, "Failed to send message"),
      });
    },
  });

  const starting = startMutation.isPending;
  const sending = sendMutation.isPending;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSend = (content: string) => {
    const text = content.trim();
    if (!text || !sessionId) {
      return;
    }
    // Re-pin to the latest so the outgoing message and the streamed
    // response are in view, even if the user had scrolled up to read
    // earlier content before sending.
    scrollToLatest();
    sendMutation.mutate({
      path: { assistant_id: assistantId, session_id: sessionId },
      body: { content: text },
    });
  };

  const handleOpenFeedback = useCallback((draft?: {
    message?: string;
    reason?: FeedbackReason;
  }) => {
    const initialMessage = draft?.message?.trim() || undefined;
    setFeedbackDraft({ message: initialMessage, reason: draft?.reason });
    setFeedbackOpen(true);
  }, []);

  const handleCloseFeedback = useCallback(() => {
    setFeedbackOpen(false);
    setFeedbackDraft(null);
  }, []);

  const refetchHistoryDetail = historyDetailQuery.refetch;
  const handleUserOutcomeRespond = useCallback(
    (entryId: string, resolved: boolean) => {
      const store = useDoctorPanelStore.getState();
      const isHistoryView = store.sessionId === null;
      const targetSessionId = store.sessionId ?? latestHistorySessionId;
      if (!assistantId || !targetSessionId) {
        return;
      }
      // Optimistic answer for the live-session view (store-backed entries).
      const existingEntry = store.entries.find((entry) => entry.id === entryId);
      const previousAnswer =
        existingEntry?.kind === "user_outcome_prompt"
          ? existingEntry.meta?.answer
          : undefined;
      const setAnswer = (answer: DoctorUserOutcomeAnswer | undefined) => {
        store.updateEntries((entries) =>
          entries.map((entry) =>
            entry.id === entryId && entry.kind === "user_outcome_prompt"
              ? { ...entry, meta: { ...entry.meta, answer } }
              : entry,
          ),
        );
      };
      setAnswer(resolved ? "resolved" : "not_resolved");
      assistantsDoctorSessionsUserOutcomeCreate({
        path: { assistant_id: assistantId, session_id: targetSessionId },
        body: { resolved },
        throwOnError: false,
      }).then(({ error }) => {
        if (error) {
          // Roll back so the prompt stays retryable — the answer wasn't persisted.
          setAnswer(previousAnswer);
          captureError(error, { context: "doctor_session_user_outcome" });
        } else if (isHistoryView) {
          // History-view entries render from the query cache, not the
          // store — refetch so the answered state comes back via
          // applySessionUserOutcome.
          void refetchHistoryDetail();
        }
      });
      if (!resolved) {
        handleOpenFeedback({
          message: "The Doctor wasn't able to solve my problem: ",
        });
      }
    },
    [assistantId, latestHistorySessionId, handleOpenFeedback, refetchHistoryDetail],
  );

  const handleEndSession = () => {
    abort();
    const store = useDoctorPanelStore.getState();
    if (store.sessionId && assistantId) {
      cleanupServerSession(assistantId, store.sessionId);
    }
    store.teardown();
  };

  const handleNewSession = () => {
    abort();
    const store = useDoctorPanelStore.getState();
    if (store.sessionId && assistantId) {
      cleanupServerSession(assistantId, store.sessionId);
    }
    store.resetForNewSession();
  };

  // ---------------------------------------------------------------------------
  // Lifecycle effects
  // ---------------------------------------------------------------------------

  // Derived transcript entries — live store entries during an active
  // session, otherwise the most recent persisted history (unless the
  // user dismissed it). The array identity changes on every store
  // append/update, which is what re-fires the scroll coordinator.
  const entries = useMemo(
    () => (sessionId || storeEntries.length > 0 ? storeEntries : (!historyDismissed ? historyEntries : [])),
    [sessionId, storeEntries, historyDismissed, historyEntries],
  );
  const visibleDoctorSessionId = sessionId ?? (!historyDismissed ? latestHistorySessionId : null);
  const doctorSessionLog = useMemo(
    () => serializeSessionToText(entries),
    [entries],
  );

  // When the doctor lists platform backups, surface the interactive backups
  // panel (list + restore) inline so the user can act without leaving the
  // session. Only the most recent completed listing gets the panel — earlier
  // listings are stale once the doctor (or the user) creates or restores one.
  // Persisted history replays of past sessions never get it: a transcript
  // from days ago is no place for live Create/Restore buttons.
  //
  // refreshKey remounts the panel (forcing a refetch) when the doctor
  // completes a backup mutation AFTER the listing — the mounted panel only
  // fetches on mount and after its own actions, so without this it would
  // show a stale backup set.
  const backupsPanel = useMemo(() => {
    const viewingLiveSession = sessionId !== null || storeEntries.length > 0;
    if (!viewingLiveSession) {
      return null;
    }
    let refreshKey: string | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i];
      if (
        candidate.kind !== "tool_call" ||
        candidate.meta.status !== "completed" ||
        candidate.meta.isError
      ) {
        continue;
      }
      if (candidate.meta.toolName === "list_assistant_backups") {
        return { entryId: candidate.id, refreshKey: refreshKey ?? candidate.id };
      }
      if (
        refreshKey === null &&
        (candidate.meta.toolName === "create_doctor_backup" ||
          candidate.meta.toolName === "restore_assistant_backup")
      ) {
        refreshKey = candidate.id;
      }
    }
    return null;
  }, [entries, sessionId, storeEntries]);

  // Scroll coordinator — auto-follows streaming growth only while the
  // user is pinned to the latest message. Scrolling away (drag on
  // mobile, wheel on desktop) un-pins and surfaces a "Go to Newest"
  // affordance so the user can catch up on their own instead of being
  // fought by the stream. See `use-doctor-auto-scroll.ts`.
  const { scrollContainerRef, showScrollToLatest, scrollToLatest } =
    useDoctorAutoScroll(entries);

  // Recover the stream on same-assistant remount. The module-level store
  // preserves the active session and replay cursor, while useDoctorSSE's
  // AbortController is owned by the mounted hook instance.
  useEffect(() => {
    const store = useDoctorPanelStore.getState();
    if (
      store.lastAssistantId === assistantId &&
      store.sessionStatus === "active" &&
      store.sessionId
    ) {
      connectSSE(assistantId, store.sessionId);
    }
    // Clear historyDismissed on remount so history queries re-discover new
    // sessions that may have completed while the panel was unmounted.
    if (store.historyDismissed && !store.sessionId) {
      useDoctorPanelStore.setState({ historyDismissed: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: assistantId is stable at mount time
  }, []);

  // Reset all doctor state when active assistant changes.
  useEffect(() => {
    const store = useDoctorPanelStore.getState();
    if (store.lastAssistantId === assistantId) {
      return;
    }
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

  const isSessionActive = sessionId !== null && storeSessionStatus === "active";
  const isSessionEnded = !isSessionActive && storeEntries.length > 0 &&
    (storeSessionStatus === "completed" || storeSessionStatus === "error");
  const sessionStatus = (isSessionActive || isSessionEnded)
    ? storeSessionStatus
    : (historyStatus ?? "idle");
  const isLoadingHistory = historyListEnabled && (
    historyListQuery.isLoading ||
    (!!latestHistorySessionId && historyDetailQuery.isLoading)
  );

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
              onClick={() => handleOpenFeedback()}
              className="cursor-pointer text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)]"
            >
              Share Feedback
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {entries.length > 0 && <CopySessionButton entries={entries} />}
          {isSessionActive && (
            <button
              type="button"
              onClick={handleEndSession}
              className="flex cursor-pointer items-center gap-1.5 rounded border border-[var(--system-negative-strong)] px-3 py-1.5 text-body-small-default text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Square className="h-3 w-3" />
              End Session
            </button>
          )}
        </div>
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
            onClick={() =>
              startMutation.mutate({ path: { assistant_id: assistantId } })
            }
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
          <div className="relative min-h-0 flex-1">
          <div ref={scrollContainerRef} className="h-full overflow-y-auto">
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
                          {entry.id === backupsPanel?.entryId && assistantId && (
                            <div className="mt-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-4">
                              <AssistantBackups
                                key={backupsPanel.refreshKey}
                                assistantId={assistantId}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  case "approval":
                    return (
                      <div key={entry.id} className="max-w-[90%]">
                        <ApprovalBlock
                          entry={entry}
                          onRespond={handleSend}
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
                            handleSend(response);
                          }}
                          disabled={!pendingBackup || sending}
                        />
                      </div>
                    );
                  case "feedback_prompt":
                    return (
                      <div key={entry.id} className="max-w-[90%]">
                        <FeedbackPromptBlock
                          onOpenFeedback={() =>
                            handleOpenFeedback({
                              message:
                                entry.content === "Share feedback"
                                  ? undefined
                                  : entry.content,
                              reason: entry.meta?.reason,
                            })
                          }
                        />
                      </div>
                    );
                  case "user_outcome_prompt":
                    return (
                      <div key={entry.id} className="max-w-[90%]">
                        <UserOutcomePromptBlock
                          question={entry.content}
                          answer={entry.meta?.answer}
                          onRespond={(resolved) =>
                            handleUserOutcomeRespond(entry.id, resolved)
                          }
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
                    <span className="sr-only">Thinking&hellip;</span>
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
          {showScrollToLatest && (
            <button
              type="button"
              onClick={scrollToLatest}
              aria-label="Go to newest message"
              className="pointer-events-auto absolute bottom-3 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1 rounded-full bg-[var(--surface-lift)] px-3 py-2 text-body-medium-default text-[var(--content-emphasised)] shadow-md transition-colors hover:text-[var(--content-default)]"
            >
              Go to Newest
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
          </div>

          {/* Input area */}
          {isSessionActive && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (inputValue.trim() && !sending) {
                  handleSend(inputValue);
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
                  if (e.key !== "Enter" || e.shiftKey) {
                    return;
                  }
                  if (e.nativeEvent.isComposing || e.keyCode === 229) {
                    return;
                  }
                  if (isPointerCoarse()) {
                    return;
                  }
                  e.preventDefault();
                  if (inputValue.trim() && !sending) {
                    handleSend(inputValue);
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
          {(isSessionEnded || (!isSessionActive && historyStatus && historyStatus !== "active")) && (
            <div className="flex shrink-0 items-center justify-center gap-3 py-2">
              <button
                type="button"
                onClick={handleNewSession}
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
        onClose={handleCloseFeedback}
        initialReason={feedbackDraft?.reason}
        initialMessage={feedbackDraft?.message}
        assistantId={assistantId}
        doctorSessionId={visibleDoctorSessionId}
        doctorSessionLog={doctorSessionLog}
      />
    </div>
  );
}
