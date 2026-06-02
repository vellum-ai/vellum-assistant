import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  HardDrive,
  Loader2,
  Play,
  Shield,
  Square,
  Wrench,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { MarkdownMessage } from "@vellum/design-library";
import { Button } from "@vellum/design-library/components/button";
import { Tag } from "@vellum/design-library/components/tag";

import {
  assistantsDoctorHistoryListOptions,
  assistantsDoctorHistoryRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { assistantsMaintenanceModeExitCreate } from "@/generated/api/sdk.gen";
import { getAssistant } from "@/assistant/api";
import {
  buildVellumHeaders,
  buildVellumMutatingHeaders,
} from "@/lib/auth/request-headers";
import { toast } from "@vellum/design-library";
import { captureError } from "@/lib/sentry/capture-error";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import { isPointerCoarse } from "@/utils/pointer";
import { ShareFeedbackModal } from "@/components/share-feedback-modal";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { DoctorAvatar } from "@/domains/settings/components/panels/doctor-avatar";
import {
  type ChatEntry,
  type PersistedMessage,
  type PersistedMessageKind,
  type PersistedSessionStatus,
  hasPendingApproval,
  hasPendingBackup,
  mapPersistedMessagesToEntries,
  mapPersistedStatusToPanelStatus,
  selectLatestHistorySession,
} from "@/domains/settings/components/panels/doctor-history";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const APPROVAL_RESPONSES = new Set([
  "approve",
  "approve all exec",
  "approve all future exec commands",
  "approve_all_exec",
  "deny",
]);

type DoctorEvent =
  | { type: "message"; content: string }
  | { type: "message_delta"; content: string }
  | {
      type: "tool_call";
      toolName: string;
      input: Record<string, unknown>;
      id: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "approval_required";
      toolName: string;
      input: Record<string, unknown>;
      id: string;
      description: string;
    }
  | { type: "backup_prompt"; toolName: string }
  | { type: "status"; status: "active" | "completed" | "error" }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let entryCounter = 0;
function nextId(): string {
  return `entry-${++entryCounter}`;
}

async function doctorFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = await buildVellumMutatingHeaders({
    "Content-Type": "application/json",
  });

  return fetch(url, {
    ...init,
    headers: { ...headers, ...init?.headers },
    credentials: "include",
  });
}

function doctorBasePath(assistantId: string): string {
  return `/v1/assistants/${assistantId}/doctor`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, 1500);
      })
      .catch(() => {});
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy"}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md bg-[var(--surface-overlay)] text-[var(--content-tertiary)] pointer-events-none opacity-0 transition-opacity duration-150 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 hover:text-[var(--content-secondary)] [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
    >
      <div className="relative h-3.5 w-3.5">
        <Check
          className={`absolute inset-0 h-3.5 w-3.5 text-[var(--system-positive-strong)] transition-opacity duration-150 ${
            copied ? "opacity-100" : "opacity-0"
          }`}
        />
        <Copy
          className={`absolute inset-0 h-3.5 w-3.5 transition-opacity duration-150 ${
            copied ? "opacity-0" : "opacity-100"
          }`}
        />
      </div>
    </button>
  );
}

function ToolCallBlock({ entry }: { entry: ChatEntry }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = typeof entry.meta?.toolName === "string" ? entry.meta.toolName : "tool";
  const input = entry.meta?.input && typeof entry.meta.input === "object" && !Array.isArray(entry.meta.input)
    ? (entry.meta.input as Record<string, unknown>)
    : undefined;
  const result = typeof entry.meta?.result === "string" ? entry.meta.result : undefined;
  const isError = entry.meta?.isError === true;
  const isRunning = entry.meta?.status === "running";

  const statusLabel = isRunning
    ? "Running 1 step"
    : isError
      ? "Failed 1 step"
      : "Completed 1 step";

  const canExpand =
    !isRunning &&
    (result !== undefined || (input && Object.keys(input).length > 0));

  return (
    <div className="my-1 w-full">
      <button
        type="button"
        onClick={() => {
          if (canExpand) setExpanded(!expanded);
        }}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
          isError
            ? "bg-[var(--system-negative-weak)]"
            : "bg-[var(--surface-base)]"
        } ${canExpand ? "cursor-pointer hover:bg-[var(--surface-hover)]" : "cursor-default"} ${
          expanded ? "rounded-b-none" : ""
        }`}
      >
        {isRunning ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--content-disabled)]" />
        ) : isError ? (
          <XCircle className="h-4 w-4 shrink-0 text-[var(--system-negative-strong)]" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--system-positive-strong)]" />
        )}
        <span
          className={`text-body-medium-default ${isError ? "text-[var(--system-negative-strong)]" : "text-[var(--content-default)]"}`}
        >
          {statusLabel}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[var(--content-tertiary)]">
          {canExpand &&
            (expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            ))}
        </span>
      </button>

      {expanded && canExpand && (
        <div
          className={`rounded-b-lg border-t px-3 pb-3 ${
            isError
              ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)]"
              : "border-[var(--border-base)] bg-[var(--surface-base)] dark:bg-[var(--surface-lift)]"
          }`}
        >
          <div className="flex items-center gap-2 py-2">
            <Wrench className="h-3.5 w-3.5" />
            <span className="text-body-medium-lighter text-[var(--content-default)]">
              {toolName}
            </span>
          </div>

          <div className="border-t border-[var(--border-base)]" />

          <div className="mt-2.5">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--content-disabled)]">
              Technical Details
            </div>
            {input &&
              Object.entries(input).map(([key, value]) => (
                <div key={key} className="mt-0.5">
                  <span className="text-body-medium-default text-[var(--content-default)]">
                    {key}:
                  </span>{" "}
                  <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                    {typeof value === "string"
                      ? value.length > 200
                        ? value.slice(0, 200) + "..."
                        : value
                      : JSON.stringify(value)}
                  </span>
                </div>
              ))}
          </div>

          {result !== undefined && (
            <div className="mt-3">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--content-disabled)]">
                Output
              </div>
              <div
                className={`rounded-md border p-3 ${
                  isError
                    ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)]/50"
                    : "border-[var(--border-element)] bg-[var(--surface-base)]"
                }`}
              >
                <pre
                  className={`max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-body-small-default ${
                    isError
                      ? "text-[var(--system-negative-strong)]"
                      : "text-[var(--content-default)]"
                  }`}
                >
                  {result.length > 2000
                    ? result.slice(0, 2000) + "..."
                    : result}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalBlock({
  entry,
  onRespond,
  disabled,
}: {
  entry: ChatEntry;
  onRespond: (response: string) => void;
  disabled: boolean;
}) {
  const toolName = typeof entry.meta?.toolName === "string" ? entry.meta.toolName : "tool";
  const description = typeof entry.meta?.description === "string" ? entry.meta.description : "";
  const input = entry.meta?.input && typeof entry.meta.input === "object" && !Array.isArray(entry.meta.input)
    ? (entry.meta.input as Record<string, unknown>)
    : undefined;
  const [showDetails, setShowDetails] = useState(false);

  const hasDetails = !!toolName || !!description || !!input;
  const canApproveFutureExecCommands = toolName === "exec_command";

  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]" />
          <span className="text-body-medium-default text-[var(--content-default)]">
            Confirmation required
          </span>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRespond("approve")}
            className="flex items-center gap-1.5 rounded-md bg-[var(--system-positive-strong)] px-3 py-1.5 text-body-small-default text-white transition-colors hover:bg-[var(--system-positive-strong)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Allow once
          </button>
          {canApproveFutureExecCommands && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRespond("approve all exec")}
              className="flex items-center gap-1.5 rounded-md border border-[var(--system-positive-strong)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-small-default text-[var(--system-positive-strong)] transition-colors hover:bg-[var(--system-positive-weak)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Always Allow
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRespond("deny")}
            className="flex items-center gap-1.5 rounded-md border border-[var(--system-negative-strong)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-small-default text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      </div>

      {hasDetails && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-default)]"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${showDetails ? "rotate-90" : ""}`}
            />
            {showDetails ? "Hide details" : "Show details"}
          </button>
          {showDetails && (
            <div className="mt-2 space-y-1.5">
              {toolName && (
                <div className="flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]">
                  <span>Tool:</span>
                  <code className="rounded bg-[var(--surface-base)] px-1.5 py-0.5 font-mono text-[var(--content-secondary)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]">
                    {toolName}
                  </code>
                </div>
              )}
              {description && (
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  {description}
                </p>
              )}
              {input && Object.keys(input).length > 0 && (
                <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-[var(--surface-base)] p-2 text-label-medium-default text-[var(--content-secondary)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]">
                  {JSON.stringify(input, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BackupPromptBlock({
  entry,
  onRespond,
  disabled,
}: {
  entry: ChatEntry;
  onRespond: (response: string) => void;
  disabled: boolean;
}) {
  const toolName = typeof entry.meta?.toolName === "string" ? entry.meta.toolName : "tool";

  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]" />
          <div className="flex flex-col gap-1">
            <span className="text-body-medium-default text-[var(--content-default)]">
              Create a backup before modifying?
            </span>
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              The doctor is about to run{" "}
              <code className="rounded bg-[var(--surface-base)] px-1 py-0.5 font-mono text-[var(--content-secondary)]">
                {toolName}
              </code>
              . Would you like to back up your workspace first?
            </span>
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => onRespond("backup")}
          >
            Back up
          </Button>
          <Button
            variant="outlined"
            disabled={disabled}
            onClick={() => onRespond("skip_backup")}
          >
            Skip
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DoctorPanel({
  assistantId: providedAssistantId,
}: {
  assistantId?: string | null;
} = {}) {
  const shouldFetchAssistant = providedAssistantId === undefined;
  const [fetchedAssistantId, setFetchedAssistantId] = useState<string | null>(
    null,
  );
  const [fetchedAssistantLoading, setFetchedAssistantLoading] =
    useState(shouldFetchAssistant);
  const assistantId = shouldFetchAssistant
    ? fetchedAssistantId
    : providedAssistantId;
  const loading = shouldFetchAssistant && fetchedAssistantLoading;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<
    "idle" | "active" | "completed" | "error"
  >("idle");
  const [pendingApproval, setPendingApproval] = useState(false);
  const [pendingBackup, setPendingBackup] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const platformGate = usePlatformGate();
  const [thinking, setThinking] = useState(false);
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<
    string | null
  >(null);
  const [appliedHistorySessionId, setAppliedHistorySessionId] = useState<
    string | null
  >(null);
  const [historyAutoLoadAttempted, setHistoryAutoLoadAttempted] =
    useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<AbortController | null>(null);
  const fetchedRef = useRef(false);
  const streamingEntryIdRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Persisted history queries
  // ---------------------------------------------------------------------------

  const historyListEnabled =
    !!assistantId && sessionId === null && !historyAutoLoadAttempted;
  const historyListOptions = assistantId
    ? { path: { assistant_id: assistantId }, query: { limit: 1 } }
    : { path: { assistant_id: "" }, query: { limit: 1 } };
  const historyListQuery = useQuery({
    ...assistantsDoctorHistoryListOptions(historyListOptions),
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

  const historyDetailOptions =
    assistantId && selectedHistorySessionId
      ? {
          path: {
            assistant_id: assistantId,
            doctor_session_id: selectedHistorySessionId,
          },
        }
      : {
          path: { assistant_id: "", doctor_session_id: "" },
        };
  const historyDetailQuery = useQuery({
    ...assistantsDoctorHistoryRetrieveOptions(historyDetailOptions),
    enabled: !!assistantId && !!selectedHistorySessionId && sessionId === null,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [entries]);

  useEffect(() => {
    if (!shouldFetchAssistant) return;
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    (async () => {
      try {
        const result = await getAssistant();
        if (result.ok) {
          setFetchedAssistantId(result.data.id);
        }
      } catch (error) {
        captureError(error, { context: "fetch_assistant_for_doctor" });
        toast.error("Failed to load assistant info");
      } finally {
        setFetchedAssistantLoading(false);
      }
    })();
  }, [shouldFetchAssistant]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.abort();
      eventSourceRef.current = null;
    };
  }, []);

  const appendEntry = useCallback(
    (entry: Omit<ChatEntry, "id" | "timestamp">) => {
      setEntries((prev) => [
        ...prev,
        { ...entry, id: nextId(), timestamp: Date.now() },
      ]);
    },
    [],
  );

  const connectSSE = useCallback(
    (asstId: string, sessId: string) => {
      const controller = new AbortController();
      eventSourceRef.current = controller;

      const url = `${doctorBasePath(asstId)}/sessions/${sessId}/events/`;
      let streamEndedTerminally = false;

      const isCurrentStream = () => eventSourceRef.current === controller;

      const failStream = (content: string) => {
        if (!isCurrentStream()) return;
        eventSourceRef.current = null;
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
            headers: buildVellumHeaders({
              Accept: "text/event-stream",
              ...getClientRegistrationHeaders(),
            }),
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
                try {
                  const event = JSON.parse(trimmed.slice(6)) as DoctorEvent;
                  handleEvent(event);
                } catch {
                  // ignore malformed events
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

      function handleEvent(event: DoctorEvent) {
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
                  typeof e.meta?.id === "string" && e.meta.id === event.toolCallId,
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
    [appendEntry],
  );

  useEffect(() => {
    if (sessionId !== null) return;
    if (!selectedHistorySessionId) return;
    if (appliedHistorySessionId === selectedHistorySessionId) return;

    if (historyDetailQuery.isError) {
      captureError(historyDetailQuery.error, { context: "doctor_history_detail" });
      setAppliedHistorySessionId(selectedHistorySessionId);
      return;
    }

    const detail = historyDetailQuery.data;
    if (!detail) return;

    const messages = (detail.messages ?? []) as PersistedMessage[];
    const normalized: PersistedMessage[] = messages.map((m) => ({
      id: m.id,
      kind: m.kind as PersistedMessageKind,
      content: m.content,
      metadata: m.metadata,
      sequence: m.sequence,
      occurred_at: m.occurred_at,
    }));
    const resumedEntries = mapPersistedMessagesToEntries(normalized);
    setEntries(resumedEntries);
    const panelStatus = mapPersistedStatusToPanelStatus(
      detail.status as PersistedSessionStatus,
    );
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

      const data = await response.json();
      const sessId = data.session_id as string;
      setSelectedHistorySessionId(null);
      setAppliedHistorySessionId(null);
      setSessionId(sessId);
      setSessionStatus("active");
      setEntries([]);

      connectSSE(assistantId, sessId);

      appendEntry({
        kind: "assistant",
        content:
          "Hi! I'm the Doctor. State the nature of the issue you're experiencing with your assistant and I'll help diagnose and fix it.",
      });
    } catch (error) {
      captureError(error, { context: "start_doctor_session" });
      appendEntry({ kind: "error", content: "Failed to start doctor session" });
    } finally {
      setStarting(false);
    }
  }, [assistantId, appendEntry, connectSSE]);

  const endSession = useCallback(async () => {
    setEnding(true);
    try {
      eventSourceRef.current?.abort();
      eventSourceRef.current = null;

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
  }, [sessionId, assistantId]);

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
            body && typeof body === "object" && "detail" in body && typeof body.detail === "string"
              ? body.detail
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
    [sessionId, assistantId, appendEntry],
  );

  const handleApprovalResponse = useCallback(
    (response: string) => {
      sendMessage(response);
    },
    [sendMessage],
  );

  const handleBackupResponse = useCallback(
    (response: string) => {
      setPendingBackup(false);
      sendMessage(response);
    },
    [sendMessage],
  );

  const isSessionActive = sessionStatus === "active";
  const isSessionEnded =
    sessionStatus === "completed" || sessionStatus === "error";

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
            {ending ? "Ending…" : "End Session"}
          </button>
        )}
      </div>

      {loading ||
      (assistantId && !historyAutoLoadAttempted) ||
      (selectedHistorySessionId &&
        appliedHistorySessionId !== selectedHistorySessionId) ? (
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
                    return (
                      <div
                        key={entry.id}
                        className="group/msg flex items-start justify-end gap-1.5"
                      >
                        <div className="flex shrink-0 items-center self-center">
                          <MessageCopyButton text={entry.content} />
                        </div>
                        <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-[var(--surface-lift)] px-4 py-3 text-chat text-[var(--content-default)]">
                          {entry.content}
                        </div>
                      </div>
                    );
                  case "assistant":
                    return (
                      <div
                        key={entry.id}
                        className="group/msg flex items-start justify-start gap-1.5"
                      >
                        <div className="w-full text-chat text-[var(--content-default)]">
                          <MarkdownMessage content={entry.content} />
                        </div>
                        <div className="flex shrink-0 items-center pt-0.5">
                          <MessageCopyButton text={entry.content} />
                        </div>
                      </div>
                    );
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
                          onRespond={handleApprovalResponse}
                          disabled={!pendingApproval || sending}
                        />
                      </div>
                    );
                  case "backup_prompt":
                    return (
                      <div key={entry.id} className="max-w-[90%]">
                        <BackupPromptBlock
                          entry={entry}
                          onRespond={handleBackupResponse}
                          disabled={!pendingBackup || sending}
                        />
                      </div>
                    );
                  case "error":
                    return (
                      <div
                        key={entry.id}
                        className="flex items-start gap-2 text-body-small-default text-[var(--system-negative-strong)]"
                      >
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{entry.content}</span>
                      </div>
                    );
                  case "status":
                    return (
                      <div
                        key={entry.id}
                        className="text-center text-body-small-default text-[var(--content-disabled)]"
                      >
                        {entry.content}
                      </div>
                    );
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
                    <span className="sr-only">Thinking…</span>
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
                onClick={async () => {
                  eventSourceRef.current?.abort();
                  eventSourceRef.current = null;
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
                  setSelectedHistorySessionId(null);
                  setAppliedHistorySessionId(null);
                }}
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
