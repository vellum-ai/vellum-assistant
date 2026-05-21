import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, Download } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@vellum/design-library";
import { useActiveAssistantContext } from "@/domains/chat/active-assistant-gate.js";
import {
  buildInspectorExportFilename,
  buildInspectorExportZipBlob,
  downloadBlob,
} from "@/domains/chat/inspector/inspector-export.js";
import { useLlmContext } from "@/domains/chat/inspector/inspector-api.js";
import {
  llmLogPayloadQueryOptions,
  type LlmLogPayload,
} from "@/domains/chat/inspector/inspector-payload-api.js";
import type {
  LlmContextResponse,
  LLMRequestLogEntry,
} from "@/domains/chat/types/inspector-types.js";
import { routes } from "@/utils/routes.js";

import { CallRail } from "./call-rail.js";
import { TabBar, type InspectorTab } from "./tab-bar.js";
import { MemoryTab } from "./tabs/memory-tab.js";
import { OverviewTab } from "./tabs/overview-tab.js";
import { PromptTab } from "./tabs/prompt-tab.js";
import { RawTab } from "./tabs/raw-tab.js";
import { ResponseTab } from "./tabs/response-tab.js";

interface MessageInspectorViewProps {
  conversationKey: string;
  messageId: string;
}

/**
 * Three-region inspector layout: header with back nav and call count,
 * a left call rail listing every LLM call captured for this message,
 * and a tabbed detail pane for the selected call.
 *
 * The selected call is encoded as `?callId=...` in the URL so each
 * row in the rail is a real hyperlink — sharable, right-click-openable,
 * and back/forward navigable.
 */
export function MessageInspectorView({
  conversationKey,
  messageId,
}: MessageInspectorViewProps): ReactNode {
  const { assistantId } = useActiveAssistantContext();
  const {
    data,
    isLoading: isLoadingContext,
    isError,
    error,
    refetch,
  } = useLlmContext(assistantId, messageId);

  const logs = useMemo(() => data?.logs ?? [], [data?.logs]);
  const [searchParams] = useSearchParams();
  const callIdParam = searchParams.get("callId");

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
        params.set("conversationKey", conversationKey);
        params.set("messageId", messageId);
        params.set("callId", logId);
        return `${routes.inspect}?${params.toString()}`;
      },
    [conversationKey, messageId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        assistantId={assistantId}
        conversationKey={conversationKey}
        context={data}
        messageId={messageId}
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
          <EmptyState />
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
  assistantId: string;
  conversationKey: string;
  context: LlmContextResponse | undefined;
  messageId: string;
  callCount: number | null;
}

function Header({
  assistantId,
  conversationKey,
  context,
  messageId,
  callCount,
}: HeaderProps): ReactNode {
  const queryClient = useQueryClient();
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const canExport = Boolean(context && context.logs.length > 0);

  async function handleExport(): Promise<void> {
    if (!context || isExporting) return;
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
      downloadBlob(blob, buildInspectorExportFilename(messageId));
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
    <div className="flex items-center gap-3 px-4 py-3">
      <Button
        asChild
        variant="ghost"
        size="compact"
        leftIcon={<ArrowLeft size={16} aria-hidden />}
      >
        <Link
          to={routes.conversation(conversationKey)}
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
        <p
          className="text-label-default"
          style={{ color: "var(--content-secondary)" }}
        >
          Select a call to inspect provider, model, and usage details.
        </p>
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
          <code
            className="select-text text-body-small-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {messageId}
          </code>
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
  );
}

interface LoadedProps {
  logs: LLMRequestLogEntry[];
  context: LlmContextResponse | undefined;
  selectedLog: LLMRequestLogEntry | null;
  selectedLogId: string | undefined;
  buildCallHref: (logId: string) => string;
  assistantId: string;
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
          {tab === "memory" ? (
            <MemoryTab context={context} />
          ) : selectedLog ? (
            <TabContent
              tab={tab}
              entry={selectedLog}
              assistantId={assistantId}
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
  tab: Exclude<InspectorTab, "memory">;
  entry: LLMRequestLogEntry;
  assistantId: string;
  conversationTotalEstimatedCostUsd: number | null | undefined;
}

function TabContent({
  tab,
  entry,
  assistantId,
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
  }
}

function CenteredMessage({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "muted" | "default";
}): ReactNode {
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

function EmptyState(): ReactNode {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h2
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        No LLM calls recorded for this message.
      </h2>
      <p
        className="max-w-md text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Either the message wasn&rsquo;t produced by an LLM call or its
        request logs were trimmed by retention.
      </p>
    </div>
  );
}

function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): ReactNode {
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
