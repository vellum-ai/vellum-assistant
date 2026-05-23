import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, Download, MessageSquare } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@vellum/design-library";
import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate.js";
import type { RuntimeMessage } from "@/domains/chat/api/messages.js";
import { canUseLlmInspector } from "@/domains/chat/inspector/access.js";
import {
  useConversationMessageList,
  useLlmContext,
} from "@/domains/chat/inspector/inspector-api.js";
import {
  buildInspectorExportFilename,
  buildInspectorExportZipBlob,
  downloadBlob,
} from "@/domains/chat/inspector/inspector-export.js";
import {
  llmLogPayloadQueryOptions,
  type LlmLogPayload,
} from "@/domains/chat/inspector/inspector-payload-api.js";
import type {
  LlmContextResponse,
  LLMRequestLogEntry,
} from "@/domains/chat/types/inspector-types.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { routes } from "@/utils/routes.js";

import { CallRail } from "./components/call-rail.js";
import { TabBar, type InspectorTab } from "./components/tab-bar.js";
import { MemoryTab } from "./components/tabs/memory-tab.js";
import { SkillsTab } from "./components/tabs/skills-tab.js";
import { OverviewTab } from "./components/tabs/overview-tab.js";
import { PromptTab } from "./components/tabs/prompt-tab.js";
import { RawTab } from "./components/tabs/raw-tab.js";
import { ResponseTab } from "./components/tabs/response-tab.js";

/**
 * `/assistant/inspect` page. Two scopes, both encoded in the URL:
 *
 * - **Conversation mode** — `?conversationId=...` only. Shows every
 *   LLM call recorded for the conversation. Header carries a "Filter
 *   to message" dropdown that switches into message mode for a
 *   specific message in the transcript.
 *
 * - **Message mode** — `?conversationId=...&messageId=...`. Shows
 *   only the calls produced by the turn containing that message.
 *   Header carries a "View all conversation calls" link that drops
 *   back into conversation mode.
 *
 * Web counterpart of macOS's `MessageInspectorView`
 * (`clients/macos/vellum-assistant/Features/Chat/MessageInspectorView.swift`).
 * The selected call is encoded as `?callId=...` in the URL so each
 * row in the rail is a real hyperlink — sharable, right-click-openable,
 * and back/forward navigable. Falls back to the most recent call when
 * `callId` is absent or no longer points to a known log.
 */
export function InspectPage(): ReactNode {
  const user = useAuthStore.use.user();
  const authLoading = useAuthStore.use.isLoading();
  const [searchParams] = useSearchParams();
  const conversationId = searchParams.get("conversationId");
  const messageId = searchParams.get("messageId");

  if (authLoading) {
    return <CenteredMessage tone="muted">Loading…</CenteredMessage>;
  }

  if (!canUseLlmInspector(user)) {
    return (
      <CenteredMessage tone="muted">
        Inspector is available to Vellum developers only.
      </CenteredMessage>
    );
  }

  if (!conversationId) {
    return <MissingConversationKeyState />;
  }

  return (
    <Inspector conversationId={conversationId} messageId={messageId} />
  );
}

interface InspectorProps {
  conversationId: string;
  messageId: string | null;
}

function Inspector({ conversationId, messageId }: InspectorProps): ReactNode {
  const { assistantId } = useActiveAssistantContext();
  const {
    data,
    isLoading: isLoadingContext,
    isError,
    error,
    refetch,
  } = useLlmContext(assistantId, conversationId, messageId);

  const logs = useMemo(() => data?.logs ?? [], [data?.logs]);
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

  const buildCallHref = useMemo(
    () =>
      (logId: string): string => {
        const params = new URLSearchParams();
        params.set("conversationId", conversationId);
        if (messageId) params.set("messageId", messageId);
        params.set("callId", logId);
        return `${routes.inspect}?${params.toString()}`;
      },
    [conversationId, messageId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
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
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : !logs.length ? (
          <EmptyState messageId={messageId} />
        ) : (
          <Loaded
            logs={logs}
            context={data}
            selectedLog={selectedLog}
            selectedLogId={selectedLogId}
            buildCallHref={buildCallHref}
            assistantId={assistantId}
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

function Header({
  assistantId,
  conversationId,
  messageId,
  context,
  callCount,
}: HeaderProps): ReactNode {
  const queryClient = useQueryClient();
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const canExport = Boolean(assistantId && context && context.logs.length > 0);
  const isMessageScoped = Boolean(messageId);

  async function handleExport(): Promise<void> {
    if (!assistantId || !context || isExporting) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const payloads = await Promise.all(
        context.logs.map((log): Promise<LlmLogPayload> => {
          const options = llmLogPayloadQueryOptions(assistantId, log.id);
          return queryClient.fetchQuery(options);
        }),
      );
      const blob = await buildInspectorExportZipBlob(context, payloads);
      downloadBlob(
        blob,
        buildInspectorExportFilename(
          context.conversationId ?? context.conversationKey ?? conversationId,
        ),
      );
    } catch (err) {
      setExportError(
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Failed to export inspector data",
      );
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-3">
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
        <div className="flex flex-1 flex-col">
          <h1
            className="text-title-medium"
            style={{ color: "var(--content-default)" }}
          >
            LLM Context Inspector
          </h1>
          <ScopeSubtitle
            conversationId={conversationId}
            messageId={messageId}
          />
        </div>
        <div className="flex items-center gap-3">
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
          <div className="flex flex-col items-end gap-0.5">
            {callCount != null ? (
              <span
                className="text-label-default"
                style={{ color: "var(--content-secondary)" }}
              >
                {callCount === 1 ? "1 LLM call" : `${callCount} LLM calls`}
              </span>
            ) : null}
            {exportError ? (
              <span
                className="max-w-72 text-right text-body-small-default"
                role="alert"
                style={{ color: "var(--system-negative-strong)" }}
              >
                {exportError}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <ScopeControls
        assistantId={assistantId}
        conversationId={conversationId}
        messageId={messageId}
        isMessageScoped={isMessageScoped}
      />
    </div>
  );
}

interface ScopeSubtitleProps {
  conversationId: string;
  messageId: string | null;
}

function ScopeSubtitle({
  conversationId,
  messageId,
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
          Scoped to one message · <code>{shortMessageId(messageId)}</code>
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
  isMessageScoped: boolean;
}

function ScopeControls({
  assistantId,
  conversationId,
  messageId,
  isMessageScoped,
}: ScopeControlsProps): ReactNode {
  const navigate = useNavigate();
  const { data: messages } = useConversationMessageList(
    assistantId,
    conversationId,
  );
  const options = useMemo(
    () => buildMessageScopeOptions(messages ?? []),
    [messages],
  );

  const navigateToScope = (nextMessageId: string | null) => {
    const params = new URLSearchParams();
    params.set("conversationId", conversationId);
    if (nextMessageId) params.set("messageId", nextMessageId);
    navigate(`${routes.inspect}?${params.toString()}`);
  };

  if (isMessageScoped) {
    return (
      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="compact"
          onClick={() => navigateToScope(null)}
          aria-label="View all conversation calls"
        >
          View all conversation calls
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <label
        htmlFor="inspector-scope-select"
        className="text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Filter to message:
      </label>
      <select
        id="inspector-scope-select"
        className="rounded-md border px-2 py-1 text-label-default"
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
        disabled={options.length === 0}
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

function buildMessageScopeOptions(messages: RuntimeMessage[]): ScopeOption[] {
  const seen = new Set<string>();
  const options: ScopeOption[] = [];
  let index = 1;
  for (const m of messages) {
    const id = m.daemonMessageId ?? m.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const preview = previewContent(m.content);
    const roleLabel = m.role === "assistant" ? "Assistant" : "User";
    const label = preview
      ? `${index}. ${roleLabel} · ${preview}`
      : `${index}. ${roleLabel}`;
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

interface LoadedProps {
  logs: LLMRequestLogEntry[];
  context: LlmContextResponse | undefined;
  selectedLog: LLMRequestLogEntry | null;
  selectedLogId: string | undefined;
  buildCallHref: (logId: string) => string;
  assistantId: string | undefined;
}

function Loaded({
  logs,
  context,
  selectedLog,
  selectedLogId,
  buildCallHref,
  assistantId,
}: LoadedProps): ReactNode {
  const [tab, setTab] = useState<InspectorTab>("overview");

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
        />
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabBar selected={tab} onSelect={setTab} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {selectedLog ? (
            <TabContent
              tab={tab}
              entry={selectedLog}
              logs={logs}
              buildCallHref={buildCallHref}
              assistantId={assistantId}
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

interface TabContentProps {
  tab: InspectorTab;
  entry: LLMRequestLogEntry;
  logs: LLMRequestLogEntry[];
  buildCallHref: (logId: string) => string;
  assistantId: string | undefined;
  context: LlmContextResponse | undefined;
  conversationTotalEstimatedCostUsd: number | null | undefined;
}

function TabContent({
  tab,
  entry,
  logs,
  buildCallHref,
  assistantId,
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
    case "prompt":
      return <PromptTab entry={entry} />;
    case "response":
      return <ResponseTab entry={entry} />;
    case "raw":
      return <RawTab entry={entry} assistantId={assistantId} />;
    case "skills":
      return <SkillsTab logs={logs} buildCallHref={buildCallHref} />;
    case "memory":
      return <MemoryTab context={context} />;
  }
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

function MissingConversationKeyState(): ReactNode {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h2
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        Missing inspector parameters
      </h2>
      <p
        className="max-w-md text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Open the inspector from a conversation&rsquo;s overflow menu — direct
        navigation requires a <code>conversationId</code>.
      </p>
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
