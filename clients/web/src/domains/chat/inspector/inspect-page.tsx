import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, Download, MessageSquare } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useCanUseLlmInspector } from "@/domains/chat/inspector/access";
import {
  isLlmRequestLogsDisabledError,
  useConversationCallNumbering,
  useConversationMessageList,
  useLlmContext,
} from "@/domains/chat/inspector/inspector-api";
import { configGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch } from "@/generated/daemon/sdk.gen";
import {
  buildInspectorExportFilename,
  buildInspectorExportZipBlobBatched,
} from "@/domains/chat/inspector/inspector-export";
import {
  llmCallDetailQueryOptions,
  useLlmCallDetail,
} from "@/domains/chat/inspector/inspector-detail-api";
import { llmLogPayloadQueryOptions } from "@/domains/chat/inspector/inspector-payload-api";
import { normalizeContentBlocks } from "@/domains/chat/api/messages";
import {
  supportsLlmContextSummaryView,
  useSupportsLlmContextSummaryView,
} from "@/lib/backwards-compat/llm-context-summary-view";
import { isElectron } from "@/runtime/is-electron";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useIsSessionInitializing } from "@/stores/auth-store";
import { routes } from "@/utils/routes";
import type {
  ConversationMessage,
  ConversationTextBlock,
  LlmContextResponse,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";
import { Button } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { CallRail } from "./components/call-rail";
import {
  ExportProgressModal,
  type ExportPhase,
} from "./components/export-progress-modal";
import { MobileCallSelector } from "./components/mobile-call-selector";
import { TabBar, type InspectorTab } from "./components/tab-bar";
import { CompactionTab } from "./components/tabs/compaction-tab";
import { MemoryTab } from "./components/tabs/memory-tab";
import { OverviewTab } from "./components/tabs/overview-tab";
import { PromptTab } from "./components/tabs/prompt-tab";
import { RawTab } from "./components/tabs/raw-tab";
import { ResponseTab } from "./components/tabs/response-tab";
import { SkillsTab } from "./components/tabs/skills-tab";

/**
 * `/assistant/conversations/:conversationId/inspect` page. The conversation
 * lives in the URL path; the page supports two scopes layered on top:
 *
 * - **Conversation mode** — path only. Shows every LLM call recorded for
 *   the conversation. Header carries a "Filter to message" dropdown that
 *   switches into message mode for a specific message in the transcript.
 *
 * - **Message mode** — `?messageId=...`. Shows only the calls produced by
 *   the turn containing that message. The same dropdown stays visible;
 *   selecting "All messages" drops back into conversation mode.
 *
 * The selected call is encoded as `?callId=...` in the URL so each row in
 * the rail is a real hyperlink — sharable, right-click-openable, and
 * back/forward navigable. Falls back to the most recent call when `callId`
 * is absent or no longer points to a known log.
 */
export function InspectPage(): ReactNode {
  const canInspect = useCanUseLlmInspector();
  // The developer-nav flag reads as registry-default `false` until the
  // `/feature-flags` response lands, so flag-gated sessions (e.g. local
  // gateway) would flash the denial on deep links. Treat the pre-hydration
  // window as loading instead.
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const authLoading = useIsSessionInitializing();
  // React Router's :conversationId segment is the source of truth; the
  // route definition guarantees it's present, but useParams still types
  // it as optional so we narrow defensively.
  const { conversationId } = useParams<{ conversationId: string }>();
  const [searchParams] = useSearchParams();
  const messageId = searchParams.get("messageId");

  if (authLoading || (!canInspect && !flagsHydrated)) {
    return <CenteredMessage tone="muted">Loading…</CenteredMessage>;
  }

  if (!canInspect) {
    return (
      <CenteredMessage tone="muted">
        Inspector is available to Vellum staff, or when the
        settings-developer-nav developer flag is enabled.
      </CenteredMessage>
    );
  }

  if (!conversationId) {
    // Defensive only — React Router would render NotFound before reaching
    // this branch, but we keep a graceful fallback rather than crashing.
    return <CenteredMessage tone="muted">Loading…</CenteredMessage>;
  }

  return <Inspector conversationId={conversationId} messageId={messageId} />;
}

interface InspectorProps {
  conversationId: string;
  messageId: string | null;
}

function Inspector({ conversationId, messageId }: InspectorProps): ReactNode {
  const assistantId = useActiveAssistantId();
  const electron = isElectron();
  const {
    data,
    isLoading: isLoadingContext,
    isError,
    error,
    refetch,
  } = useLlmContext(assistantId, conversationId, messageId);

  const logs = useMemo(() => data?.logs ?? [], [data?.logs]);
  // Best-effort conversation-wide log list (message mode only) so a
  // scoped turn keeps showing "Call 12" instead of renumbering from 1.
  // Resolves to null on daemons without the conversation endpoint, in
  // which case the rail falls back to subset-relative numbering.
  const { data: conversationLogs } = useConversationCallNumbering(
    assistantId,
    conversationId,
    Boolean(messageId),
  );
  const callNumbers = useMemo<ReadonlyMap<string, number> | undefined>(() => {
    if (!messageId || !conversationLogs?.length) return undefined;
    return new Map(conversationLogs.map((log, index) => [log.id, index + 1]));
  }, [messageId, conversationLogs]);
  const conversationCallCount =
    messageId && conversationLogs ? conversationLogs.length : undefined;
  const [searchParams] = useSearchParams();
  const callIdParam = searchParams.get("callId");

  // Derive the selected log at render time. The URL's `callId` wins
  // when it still exists in the latest log set; otherwise we fall back
  // to the most recent call so the page never renders empty.
  const selectedLogId = useMemo<string | undefined>(() => {
    if (!logs.length) return undefined;
    if (callIdParam && logs.some((log) => log.id === callIdParam)) {
      return callIdParam;
    }
    return logs[logs.length - 1]!.id;
  }, [logs, callIdParam]);

  const selectedLog = useMemo<LLMRequestLogEntry | null>(
    () => logs.find((log) => log.id === selectedLogId) ?? null,
    [logs, selectedLogId],
  );

  // The call immediately preceding the selected one in conversation
  // order — the anchor the Prompt tab's cache diff compares against.
  // In message mode `logs` holds only the selected turn's calls, so the
  // conversation-wide list is the correct ordering; falling back to it
  // keeps the first call of a scoped turn diffing against the prior
  // turn instead of a same-turn sibling (or nothing at all).
  const previousLog = useMemo<LLMRequestLogEntry | null>(() => {
    if (!selectedLogId) return null;
    const ordered =
      messageId && conversationLogs?.length ? conversationLogs : logs;
    const index = ordered.findIndex((log) => log.id === selectedLogId);
    if (index > 0) return ordered[index - 1] ?? null;
    if (index === -1 && ordered !== logs) {
      const scopedIndex = logs.findIndex((log) => log.id === selectedLogId);
      return scopedIndex > 0 ? (logs[scopedIndex - 1] ?? null) : null;
    }
    return null;
  }, [selectedLogId, messageId, conversationLogs, logs]);

  const buildCallHref = useMemo(
    () =>
      (logId: string): string => {
        const params = new URLSearchParams();
        if (messageId) params.set("messageId", messageId);
        params.set("callId", logId);
        return `${routes.inspect(conversationId)}?${params.toString()}`;
      },
    [conversationId, messageId],
  );

  // On the Electron macOS shell the window runs with a hidden title bar, so a
  // global `WindowDragRegion` drag strip and the traffic lights occupy the top
  // of the renderer. This standalone route has no inline title bar to claim that
  // band (only chat does), so — like `SidebarShell` — reserve top space to clear
  // the controls. Without it the header's back button sits under the drag strip
  // and its clicks are swallowed by window dragging. Off Electron the layout is
  // unchanged.
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={electron ? { paddingTop: "2.75rem" } : undefined}
    >
      <Header
        assistantId={assistantId}
        conversationId={conversationId}
        messageId={messageId}
        context={data}
        callCount={data ? logs.length : null}
      />
      <div
        className="flex min-h-0 flex-1"
        style={{ borderTop: "1px solid var(--border-base)" }}
      >
        {isLoadingContext ? (
          <CenteredMessage tone="muted">Loading…</CenteredMessage>
        ) : isError ? (
          isLlmRequestLogsDisabledError(error) ? (
            <LoggingDisabledState
              assistantId={assistantId}
              onEnabled={() => void refetch()}
            />
          ) : (
            <ErrorState error={error} onRetry={() => void refetch()} />
          )
        ) : !logs.length ? (
          <EmptyState messageId={messageId} />
        ) : (
          <Loaded
            logs={logs}
            previousLog={previousLog}
            context={data}
            selectedLog={selectedLog}
            selectedLogId={selectedLogId}
            buildCallHref={buildCallHref}
            assistantId={assistantId}
            conversationId={conversationId}
            callNumbers={callNumbers}
            conversationCallCount={conversationCallCount}
          />
        )}
      </div>
    </div>
  );
}

interface HeaderProps {
  assistantId: string | undefined;
  conversationId: string;
  messageId: string | null;
  context: LlmContextResponse | undefined;
  callCount: number | null;
}

/** Drives the {@link ExportProgressModal}; `null` means no export in flight. */
interface ExportRun {
  phase: ExportPhase;
  completed: number;
  total: number;
  error: string | null;
}

function Header({
  assistantId,
  conversationId,
  messageId,
  context,
  callCount,
}: HeaderProps): ReactNode {
  const queryClient = useQueryClient();
  const [exportRun, setExportRun] = useState<ExportRun | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const isExporting = exportRun?.phase === "running";

  const { data: scopeMessages } = useConversationMessageList(
    assistantId,
    conversationId,
  );
  const turnPosition = useMemo(
    () => (messageId ? findTurnPosition(scopeMessages ?? [], messageId) : null),
    [scopeMessages, messageId],
  );

  const canExport = Boolean(assistantId && context && context.logs.length > 0);

  async function handleExport(): Promise<void> {
    if (!assistantId || !context || isExporting) return;

    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportRun({
      phase: "running",
      completed: 0,
      total: context.logs.length,
      error: null,
    });

    try {
      // Batched fetch (10 in flight) so a long conversation doesn't fire
      // thousands of simultaneous requests at the daemon. Progress drives
      // the modal's determinate progress bar.
      const blob = await buildInspectorExportZipBlobBatched(context, {
        fetchPayload: (logId) =>
          queryClient.fetchQuery(llmLogPayloadQueryOptions(assistantId, logId)),
        fetchCallSections: (logId) =>
          supportsLlmContextSummaryView()
            ? queryClient.fetchQuery(
                llmCallDetailQueryOptions(assistantId, logId),
              )
            : Promise.resolve(null),
        onProgress: ({ completed, total }) =>
          setExportRun((prev) =>
            prev && prev.phase === "running"
              ? { ...prev, completed, total }
              : prev,
          ),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const { saveFile } = await import("@/runtime/native-file");
      await saveFile(
        blob,
        buildInspectorExportFilename(context.conversationId ?? conversationId),
      );
      setExportRun((prev) => (prev ? { ...prev, phase: "done" } : prev));
    } catch (err) {
      if (controller.signal.aborted) return; // user cancelled
      setExportRun((prev) => ({
        phase: "error",
        completed: prev?.completed ?? 0,
        total: prev?.total ?? 0,
        error:
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Failed to export inspector data",
      }));
    } finally {
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
      }
    }
  }

  function handleCancelExport(): void {
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    setExportRun(null);
  }

  // Mobile-responsive layout:
  // - Desktop (≥md): Back · Title block · Export+count on one row.
  // - Mobile (<md): Back · Export collapse to row 1; Title block wraps
  //   to its own row via `order-3 w-full`. Avoids the title squeeze that
  //   forced "LLM Context Inspector" to wrap inside ~120px on phones.
  // The redundant call-count label is hidden on mobile — the
  // `MobileCallSelector` pill in the content area already shows it.
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          asChild
          variant="ghost"
          size="compact"
          leftIcon={<ArrowLeft size={16} aria-hidden />}
        >
          <Link
            to={routes.conversation(conversationId)}
            aria-label="Back to conversation"
          >
            Back
          </Link>
        </Button>
        <div className="order-3 flex w-full min-w-0 flex-col md:order-2 md:w-auto md:flex-1">
          <h1
            className="truncate text-body-large-bold md:text-title-medium"
            style={{ color: "var(--content-default)" }}
          >
            LLM Context Inspector
          </h1>
          <ScopeSubtitle
            conversationId={conversationId}
            messageId={messageId}
            turnPosition={turnPosition}
          />
        </div>
        <div className="order-2 ml-auto flex items-center gap-3 md:order-3 md:ml-0">
          <Button
            variant="outlined"
            size="compact"
            leftIcon={<Download size={16} aria-hidden />}
            disabled={!canExport || isExporting}
            onClick={() => void handleExport()}
            aria-label="Export inspector data as ZIP"
          >
            {isExporting ? "Exporting…" : "Export ZIP"}
          </Button>
          {callCount != null ? (
            <span
              className="hidden text-label-default md:inline"
              style={{ color: "var(--content-secondary)" }}
            >
              {callCount === 1 ? "1 LLM call" : `${callCount} LLM calls`}
            </span>
          ) : null}
        </div>
      </div>
      {exportRun ? (
        <ExportProgressModal
          open
          phase={exportRun.phase}
          completed={exportRun.completed}
          total={exportRun.total}
          error={exportRun.error}
          onCancel={handleCancelExport}
          onRetry={() => void handleExport()}
          onClose={() => setExportRun(null)}
        />
      ) : null}
      <ScopeControls
        assistantId={assistantId}
        conversationId={conversationId}
        messageId={messageId}
      />
    </div>
  );
}

interface ScopeSubtitleProps {
  conversationId: string;
  messageId: string | null;
  turnPosition: TurnPosition | null;
}

function ScopeSubtitle({
  conversationId,
  messageId,
  turnPosition,
}: ScopeSubtitleProps): ReactNode {
  void conversationId;
  if (messageId) {
    return (
      <p
        className="text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        <span
          className="inline-flex items-center gap-1"
          style={{ color: "var(--content-default)" }}
        >
          <MessageSquare size={12} aria-hidden />
          {turnPosition
            ? `Scoped to turn ${turnPosition.index} of ${turnPosition.count} · `
            : "Scoped to one message · "}
          <code>{shortMessageId(messageId)}</code>
        </span>
      </p>
    );
  }
  return (
    <p
      className="text-label-default"
      style={{ color: "var(--content-secondary)" }}
    >
      Showing every LLM call recorded for this conversation.
    </p>
  );
}

interface ScopeControlsProps {
  assistantId: string | undefined;
  conversationId: string;
  messageId: string | null;
}

function ScopeControls({
  assistantId,
  conversationId,
  messageId,
}: ScopeControlsProps): ReactNode {
  const navigate = useNavigate();
  const { data: messages } = useConversationMessageList(
    assistantId,
    conversationId,
  );
  const options = useMemo(() => {
    const built = buildMessageScopeOptions(messages ?? []);
    // Deep links and older entry points may scope to a message that
    // isn't a turn head (e.g. an assistant message). Keep the select
    // honest by surfacing that scope as a selectable option.
    if (messageId && !built.some((opt) => opt.value === messageId)) {
      built.push({
        value: messageId,
        label: `Message ${shortMessageId(messageId)}`,
      });
    }
    return built;
  }, [messages, messageId]);

  const navigateToScope = (nextMessageId: string | null) => {
    const params = new URLSearchParams();
    if (nextMessageId) params.set("messageId", nextMessageId);
    const qs = params.toString();
    const base = routes.inspect(conversationId);
    navigate(qs ? `${base}?${qs}` : base);
  };

  // A native select's intrinsic minimum width is its widest option, so
  // long message previews would otherwise push it past the viewport on
  // phones. `w-full min-w-0 truncate` lets it shrink to the container
  // and ellipsize the selected label instead.
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <label
        htmlFor="inspector-scope-select"
        className="text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Filter to message:
      </label>
      <select
        id="inspector-scope-select"
        className="w-full min-w-0 truncate rounded-md border px-2 py-1 text-label-default sm:w-auto sm:max-w-md"
        style={{
          borderColor: "var(--border-base)",
          background: "var(--surface-base)",
          color: "var(--content-default)",
        }}
        value={messageId ?? ""}
        onChange={(event) => {
          const next = event.target.value;
          navigateToScope(next || null);
        }}
        disabled={options.length === 0 && !messageId}
      >
        <option value="">All messages</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface ScopeOption {
  value: string;
  label: string;
}

// A "turn" is headed by a user message: the user message plus every
// assistant response it produced map to the same group of LLM calls,
// so only user messages are offered as scope options.
function buildMessageScopeOptions(
  messages: ConversationMessage[],
): ScopeOption[] {
  const seen = new Set<string>();
  const options: ScopeOption[] = [];
  let index = 1;
  for (const m of messages) {
    const id = m.id;
    if (!id || seen.has(id) || m.role !== "user") continue;
    seen.add(id);
    const firstTextBlock = normalizeContentBlocks(m)?.find(
      (b): b is ConversationTextBlock => b.type === "text",
    );
    const preview = previewContent(firstTextBlock?.text);
    const label = preview ? `${index}. ${preview}` : `${index}. (no text)`;
    options.push({ value: id, label });
    index += 1;
  }
  return options;
}

function previewContent(content: string | undefined | null): string {
  if (!content) return "";
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 60) return collapsed;
  return `${collapsed.slice(0, 57)}…`;
}

function shortMessageId(messageId: string): string {
  return messageId.length > 12 ? `${messageId.slice(0, 8)}…` : messageId;
}

interface TurnPosition {
  /** 1-based position of the turn among the conversation's user turns. */
  index: number;
  /** Total number of user turns in the conversation. */
  count: number;
}

/**
 * Locates the turn containing `messageId` within the transcript. The
 * scoped id is normally a turn-head user message, but deep links may
 * carry an assistant message id — those resolve to the user message
 * that heads their turn. Returns `null` when the id isn't in the list.
 */
function findTurnPosition(
  messages: ConversationMessage[],
  messageId: string,
): TurnPosition | null {
  const seen = new Set<string>();
  const userIds: string[] = [];
  let headId: string | null = null;
  for (const m of messages) {
    const id = m.id;
    if (id && m.role === "user" && !seen.has(id)) {
      seen.add(id);
      userIds.push(id);
    }
    if (id === messageId && !headId) {
      headId = m.role === "user" ? id : (userIds[userIds.length - 1] ?? null);
    }
  }
  if (!headId) return null;
  const index = userIds.indexOf(headId);
  return index === -1 ? null : { index: index + 1, count: userIds.length };
}

interface LoadedProps {
  logs: LLMRequestLogEntry[];
  previousLog: LLMRequestLogEntry | null;
  context: LlmContextResponse | undefined;
  selectedLog: LLMRequestLogEntry | null;
  selectedLogId: string | undefined;
  buildCallHref: (logId: string) => string;
  assistantId: string | undefined;
  conversationId: string;
  callNumbers: ReadonlyMap<string, number> | undefined;
  conversationCallCount: number | undefined;
}

function Loaded({
  logs,
  previousLog,
  context,
  selectedLog,
  selectedLogId,
  buildCallHref,
  assistantId,
  conversationId,
  callNumbers,
  conversationCallCount,
}: LoadedProps): ReactNode {
  const [tab, setTab] = useState<InspectorTab>("overview");

  // On assistants with summary-view support, the list omits per-log
  // sections, so the selected call's request/response sections are
  // loaded lazily here and merged into the entry. Older assistants
  // return sections inline and the list entry is used as-is.
  const supportsSummaryView = useSupportsLlmContextSummaryView();
  const selectedLogHasSections = Boolean(
    selectedLog &&
    (selectedLog.requestSections || selectedLog.responseSections),
  );
  const shouldFetchDetail = supportsSummaryView && !selectedLogHasSections;
  const {
    data: detail,
    isPending: isDetailPending,
    isError: isDetailError,
  } = useLlmCallDetail(
    shouldFetchDetail ? assistantId : undefined,
    selectedLogId,
  );
  const selectedEntry = useMemo<LLMRequestLogEntry | null>(() => {
    if (!selectedLog) return null;
    if (!shouldFetchDetail || !detail) return selectedLog;
    return {
      ...selectedLog,
      requestSections: detail.requestSections,
      responseSections: detail.responseSections,
    };
  }, [selectedLog, shouldFetchDetail, detail]);
  const detailState: DetailState = !shouldFetchDetail
    ? "loaded"
    : isDetailError
      ? "error"
      : detail
        ? "loaded"
        : isDetailPending
          ? "loading"
          : "loaded";

  return (
    <>
      <aside
        className="hidden w-64 shrink-0 overflow-y-auto md:block"
        style={{
          background: "var(--surface-base)",
          borderRight: "1px solid var(--border-base)",
        }}
      >
        <CallRail
          logs={logs}
          selectedLogId={selectedLogId}
          buildCallHref={buildCallHref}
          callNumbers={callNumbers}
        />
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile counterpart to the desktop aside. The wrapper hides
            both the trigger button and the BottomSheet portal mount on
            ≥md viewports — the aside above takes over there. */}
        <div className="md:hidden">
          <MobileCallSelector
            logs={logs}
            selectedLogId={selectedLogId}
            buildCallHref={buildCallHref}
            callNumbers={callNumbers}
            conversationCallCount={conversationCallCount}
          />
        </div>
        <TabBar selected={tab} onSelect={setTab} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {selectedEntry ? (
            <TabContent
              tab={tab}
              entry={selectedEntry}
              previousLog={previousLog}
              detailState={detailState}
              logs={logs}
              buildCallHref={buildCallHref}
              assistantId={assistantId}
              conversationId={conversationId}
              context={context}
              conversationTotalEstimatedCostUsd={
                context?.conversationTotalEstimatedCostUsd
              }
            />
          ) : (
            <CenteredMessage tone="muted">
              Choose a call from the rail to inspect its context.
            </CenteredMessage>
          )}
        </div>
      </main>
    </>
  );
}

type DetailState = "loading" | "loaded" | "error";

interface TabContentProps {
  tab: InspectorTab;
  entry: LLMRequestLogEntry;
  previousLog: LLMRequestLogEntry | null;
  detailState: DetailState;
  logs: LLMRequestLogEntry[];
  buildCallHref: (logId: string) => string;
  assistantId: string | undefined;
  conversationId: string;
  context: LlmContextResponse | undefined;
  conversationTotalEstimatedCostUsd: number | null | undefined;
}

function TabContent({
  tab,
  entry,
  previousLog,
  detailState,
  logs,
  buildCallHref,
  assistantId,
  conversationId,
  context,
  conversationTotalEstimatedCostUsd,
}: TabContentProps): ReactNode {
  switch (tab) {
    case "overview":
      return (
        <OverviewTab
          entry={entry}
          conversationTotalEstimatedCostUsd={conversationTotalEstimatedCostUsd}
        />
      );
    case "prompt": {
      if (detailState !== "loaded") {
        return <DetailPlaceholder state={detailState} />;
      }
      return (
        <PromptTab
          entry={entry}
          previous={previousLog}
          assistantId={assistantId}
        />
      );
    }
    case "response":
      if (detailState !== "loaded") {
        return <DetailPlaceholder state={detailState} />;
      }
      return <ResponseTab entry={entry} />;
    case "raw":
      return <RawTab entry={entry} assistantId={assistantId} />;
    case "compaction":
      return (
        <CompactionTab
          assistantId={assistantId}
          conversationId={conversationId}
          entry={entry}
        />
      );
    case "skills":
      return <SkillsTab logs={logs} buildCallHref={buildCallHref} />;
    case "memory":
      return <MemoryTab context={context} assistantId={assistantId} />;
  }
}

function DetailPlaceholder({ state }: { state: DetailState }): ReactNode {
  if (state === "error") {
    return (
      <CenteredMessage>
        Failed to load this call’s normalized context.
      </CenteredMessage>
    );
  }
  return <CenteredMessage tone="muted">Loading…</CenteredMessage>;
}

interface CenteredMessageProps {
  children: ReactNode;
  tone?: "muted" | "default";
}

function CenteredMessage({
  children,
  tone = "default",
}: CenteredMessageProps): ReactNode {
  const color =
    tone === "muted" ? "var(--content-tertiary)" : "var(--content-secondary)";
  return (
    <div
      className="flex h-full w-full items-center justify-center p-8 text-label-default"
      style={{ color }}
    >
      {children}
    </div>
  );
}

interface EmptyStateProps {
  messageId: string | null;
}

function EmptyState({ messageId }: EmptyStateProps): ReactNode {
  const title = messageId
    ? "No LLM calls recorded for this message."
    : "No LLM calls recorded for this conversation.";
  const body = messageId
    ? "Either this message wasn’t produced by an LLM call or its request logs were trimmed by retention."
    : "Either no message in the conversation was produced by an LLM call or the request logs were trimmed by retention.";
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h2
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </h2>
      <p
        className="max-w-md text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {body}
      </p>
    </div>
  );
}

interface LoggingDisabledStateProps {
  assistantId: string | undefined;
  onEnabled: () => void;
}

/**
 * Rendered when the daemon reports that LLM request logging is turned off
 * (`llmRequestLogs.enabled === false`). There's nothing to inspect, so instead
 * of the generic error state we explain the situation and offer a toggle that
 * flips the setting back on for future calls. Enabling patches the daemon
 * config, invalidates the cached config view, and re-runs the inspector query.
 */
function LoggingDisabledState({
  assistantId,
  onEnabled,
}: LoggingDisabledStateProps): ReactNode {
  const queryClient = useQueryClient();
  const [enabling, setEnabling] = useState(false);

  async function handleEnable(next: boolean): Promise<void> {
    // The toggle starts off; only act on the off → on transition.
    if (!next || enabling || !assistantId) return;
    setEnabling(true);
    try {
      const { response } = await configPatch({
        path: { assistant_id: assistantId },
        body: { llmRequestLogs: { enabled: true } },
        throwOnError: false,
      });
      if (!response?.ok) {
        throw new Error(`HTTP ${response?.status ?? "?"}`);
      }
      void queryClient.invalidateQueries({
        queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      toast.success("LLM request logging enabled");
      onEnabled();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Failed to enable logging (${err.message})`
          : "Failed to enable logging",
      );
    } finally {
      setEnabling(false);
    }
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertCircle
        size={32}
        aria-hidden
        style={{ color: "var(--content-secondary)" }}
      />
      <h2
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        LLM request logging is off
      </h2>
      <p
        className="max-w-md text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Request and response payloads aren’t being recorded, so there’s nothing
        to inspect. Enable logging to capture future LLM calls.
      </p>
      <Toggle
        checked={false}
        disabled={enabling || !assistantId}
        onChange={(next) => void handleEnable(next)}
        label={enabling ? "Enabling…" : "Enable logging"}
      />
    </div>
  );
}

interface ErrorStateProps {
  error: unknown;
  onRetry: () => void;
}

function ErrorState({ error, onRetry }: ErrorStateProps): ReactNode {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : "Failed to load LLM context.";
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertCircle
        size={32}
        aria-hidden
        style={{ color: "var(--content-secondary)" }}
      />
      <h2
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        Failed to load
      </h2>
      <p
        className="max-w-md text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {message}
      </p>
      <Button variant="outlined" size="compact" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
