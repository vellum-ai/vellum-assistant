import { useQuery } from "@tanstack/react-query";
import {
    AlertTriangle,
    ChevronDown,
    ChevronUp,
    Loader2,
    ScrollText,
} from "lucide-react";
import { createElement, useCallback, useMemo, useState } from "react";

import { Dropdown } from "@vellumai/design-library";

import {
    formatLatency,
    formatTimelineTimestamp,
    formatTokens,
    formatTokensCombined,
} from "@/domains/logs/format";
import {
    calculateMetrics,
    determineGroupStatus,
    getGroupStatusMeta,
    getIconForKind,
    getStatusColor,
    groupEventsByRequest,
    stringifyAttributeValue,
    type ConversationMetrics,
} from "@/domains/logs/trace-event-processing";
import {
    fetchTraceEvents,
    type TraceEventRow,
} from "@/domains/logs/trace-events-api";
import {
    useBackgroundConversationListQuery,
    useConversationListQuery,
    useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";
import type { Conversation } from "@/types/conversation-types";
import { mergeConversationLists } from "@/utils/conversation-cache";
import {
    loadLastViewedConversationId,
    saveLastViewedConversationId,
} from "@/utils/last-viewed-conversation-storage";

interface LogsTabProps {
  assistantId: string;
}

const TRACE_EVENT_LIMIT = 500;

export function LogsTab({ assistantId }: LogsTabProps) {
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);

  const {
    conversations: foregroundConversations,
    isLoading: isLoadingConversations,
    isError: isConversationsError,
    error: conversationsError,
  } = useConversationListQuery(assistantId);

  // The logs picker lists every conversation, so it eagerly mounts the
  // background and scheduled lists rather than waiting for a sidebar reveal —
  // unlike the chat sidebar, there is no collapse affordance to gate the
  // fetches on.
  const { conversations: backgroundConversations } =
    useBackgroundConversationListQuery(assistantId, true);
  const { conversations: scheduledConversations } =
    useScheduledConversationListQuery(assistantId, true);

  const conversations = useMemo<Conversation[]>(
    () =>
      mergeConversationLists(
        foregroundConversations,
        backgroundConversations,
        scheduledConversations,
      ).filter((c) => c.archivedAt == null),
    [foregroundConversations, backgroundConversations, scheduledConversations],
  );

  const activeConversationId = useMemo(() => {
    if (selectedConversationId) {
      const match = conversations.find(
        (c) => c.conversationId === selectedConversationId,
      );
      if (match) {
        return match.conversationId;
      }
    }
    const lastViewed = loadLastViewedConversationId(assistantId);
    if (lastViewed) {
      const match = conversations.find((c) => c.conversationId === lastViewed);
      if (match) {
        return match.conversationId;
      }
    }
    return conversations[0]?.conversationId ?? "";
  }, [assistantId, conversations, selectedConversationId]);

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      setSelectedConversationId(conversationId);
      saveLastViewedConversationId(assistantId, conversationId);
    },
    [assistantId],
  );

  const {
    data,
    isLoading: isLoadingEvents,
    isError,
    error,
  } = useQuery({
    queryKey: ["trace-events", assistantId, activeConversationId],
    queryFn: () =>
      fetchTraceEvents(assistantId, {
        conversationId: activeConversationId,
        limit: TRACE_EVENT_LIMIT,
      }),
    enabled: activeConversationId.length > 0,
  });

  const events = useMemo<TraceEventRow[]>(() => data?.events ?? [], [data]);
  const metrics = useMemo(() => calculateMetrics(events), [events]);
  const groups = useMemo(() => groupEventsByRequest(events), [events]);

  const hasConversations = conversations.length > 0;

  return (
    <div className="flex flex-col gap-6">
      {isLoadingConversations ? (
        <div className="flex items-center justify-center py-16">
          <Loader2
            className="h-6 w-6 animate-spin"
            style={{ color: "var(--content-secondary)" }}
          />
        </div>
      ) : isConversationsError ? (
        <ErrorMessage
          message={
            conversationsError instanceof Error
              ? conversationsError.message
              : "Failed to load conversations."
          }
        />
      ) : !hasConversations ? (
        <EmptyPlaceholder
          title="No conversations yet"
          subtitle="Start a conversation to generate trace events."
        />
      ) : (
        <>
          <ConversationPicker
            conversations={conversations}
            selectedConversationId={activeConversationId}
            onSelect={handleSelectConversation}
          />

          {isLoadingEvents ? (
            <div className="flex items-center justify-center py-16">
              <Loader2
                className="h-6 w-6 animate-spin"
                style={{ color: "var(--content-secondary)" }}
              />
            </div>
          ) : isError ? (
            <ErrorMessage
              message={
                error instanceof Error
                  ? error.message
                  : "Failed to load trace events."
              }
            />
          ) : (
            <>
              <SessionMetricsCard metrics={metrics} />
              {events.length === 0 ? (
                <EmptyPlaceholder
                  title="No trace events yet"
                  subtitle="Events will appear as the session runs."
                />
              ) : (
                <TraceTimeline groups={groups} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ConversationPicker({
  conversations,
  selectedConversationId,
  onSelect,
}: {
  conversations: Conversation[];
  selectedConversationId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor="logs-conversation-picker"
        className="text-body-small-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Conversation
      </label>
      <Dropdown
        id="logs-conversation-picker"
        value={selectedConversationId}
        onChange={onSelect}
        options={conversations.map((conversation) => ({
          value: conversation.conversationId,
          label: conversationLabel(conversation),
        }))}
      />
    </div>
  );
}

function conversationLabel(conversation: Conversation): string {
  const title = conversation.title?.trim();
  if (title) {
    return title;
  }
  const shortId = conversation.conversationId.slice(0, 8);
  return `Conversation ${shortId}`;
}

function SessionMetricsCard({ metrics }: { metrics: ConversationMetrics }) {
  const showFailures = metrics.toolFailureCount > 0;
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border p-4"
      style={{
        background: "var(--surface-lift)",
        borderColor: "var(--border-base)",
      }}
    >
      <h3
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        Session Metrics
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MetricStatCard
          label="Requests"
          value={formatTokens(metrics.requestCount)}
        />
        <MetricStatCard
          label="LLM Calls"
          value={formatTokens(metrics.llmCallCount)}
        />
        <MetricStatCard
          label="Tokens"
          value={formatTokensCombined(
            metrics.totalInputTokens,
            metrics.totalOutputTokens,
          )}
        />
        <MetricStatCard
          label="Avg Latency"
          value={formatLatency(metrics.averageLlmLatencyMs)}
        />
        {showFailures ? (
          <MetricStatCard
            label="Failures"
            value={formatTokens(metrics.toolFailureCount)}
            valueColor="var(--system-negative-strong)"
          />
        ) : null}
      </div>
    </section>
  );
}

function MetricStatCard({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-md px-3 py-2"
      style={{
        background: "color-mix(in srgb, var(--border-base) 15%, transparent)",
      }}
    >
      <span
        className="text-body-medium-default"
        style={{ color: valueColor ?? "var(--content-default)" }}
      >
        {value}
      </span>
      <span
        className="text-body-small-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {label}
      </span>
    </div>
  );
}

function TraceTimeline({
  groups,
}: {
  groups: ReturnType<typeof groupEventsByRequest>;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h3
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        Timeline
      </h3>
      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <RequestGroup
            key={group.requestId || "__system__"}
            requestId={group.requestId}
            events={group.events}
          />
        ))}
      </div>
    </section>
  );
}

function RequestGroup({
  requestId,
  events,
}: {
  requestId: string;
  events: TraceEventRow[];
}) {
  const status = useMemo(() => determineGroupStatus(events), [events]);
  const meta = getGroupStatusMeta(status);
  const label = requestId ? `Request ${requestId.slice(0, 8)}` : "System";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {createElement(meta.Icon, {
          className: "h-3 w-3 shrink-0",
          style: { color: meta.color },
        })}
        <span
          className="text-body-small-default select-text"
          style={{ color: "var(--content-secondary)" }}
        >
          {label}
        </span>
        <div
          className="h-px flex-1"
          style={{ background: "var(--border-base)" }}
          aria-hidden
        />
      </div>
      <ol className="flex flex-col" style={{ listStyle: "none" }}>
        {events.map((event) => (
          <li key={event.eventId}>
            <EventRow event={event} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function EventRow({ event }: { event: TraceEventRow }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const attributeEntries = useMemo(() => {
    if (!event.attributes) {
      return [];
    }
    return Object.entries(event.attributes).sort(([a], [b]) =>
      a.localeCompare(b),
    );
  }, [event.attributes]);
  const hasAttributes = attributeEntries.length > 0;

  const iconComponent = getIconForKind(event.kind);
  const iconColor = getStatusColor(event.status);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          if (!hasAttributes) {
            return;
          }
          setIsExpanded((prev) => !prev);
        }}
        className="flex w-full items-start gap-2 rounded-sm px-1 py-1.5 text-left transition-colors"
        style={{
          cursor: hasAttributes ? "pointer" : "default",
        }}
        disabled={!hasAttributes}
        aria-expanded={hasAttributes ? isExpanded : undefined}
      >
        {createElement(iconComponent, {
          className: "mt-0.5 h-3.5 w-3.5 shrink-0",
          style: { color: iconColor },
        })}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="text-body-medium-lighter break-words"
            style={{ color: "var(--content-default)" }}
          >
            {event.summary}
          </span>
          <span
            className="font-mono text-body-small-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {formatTimelineTimestamp(event.timestampMs)}
          </span>
        </div>
        {hasAttributes ? (
          isExpanded ? (
            <ChevronUp
              className="mt-1 h-3 w-3 shrink-0"
              style={{ color: "var(--content-tertiary)" }}
            />
          ) : (
            <ChevronDown
              className="mt-1 h-3 w-3 shrink-0"
              style={{ color: "var(--content-tertiary)" }}
            />
          )
        ) : null}
      </button>
      {isExpanded && hasAttributes ? (
        <div
          className="mb-1 ml-6 mr-2 rounded-md px-3 py-2"
          style={{ background: "var(--surface-base)" }}
        >
          <dl className="flex flex-col gap-1">
            {attributeEntries.map(([key, value]) => (
              <div
                key={key}
                className="flex flex-col gap-0.5 sm:flex-row sm:gap-3"
              >
                <dt
                  className="shrink-0 font-mono text-body-small-default"
                  style={{ color: "var(--content-tertiary)" }}
                >
                  {key}
                </dt>
                <dd
                  className="font-mono text-body-small-default break-all"
                  style={{ color: "var(--content-secondary)" }}
                >
                  {stringifyAttributeValue(value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function EmptyPlaceholder({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-md border border-dashed px-6 py-16 text-center"
      style={{
        borderColor: "var(--border-base)",
        color: "var(--content-secondary)",
      }}
    >
      <ScrollText className="mb-3 h-8 w-8" />
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </p>
      <p className="mt-1 text-body-small-default">{subtitle}</p>
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div
      className="text-body-medium-lighter flex items-start gap-3 rounded-md border px-4 py-3"
      style={{
        background: "var(--surface-lift)",
        borderColor: "var(--border-base)",
        color: "var(--content-default)",
      }}
    >
      <AlertTriangle
        className="h-5 w-5 shrink-0"
        style={{ color: "var(--system-negative-strong)" }}
      />
      <span>{message}</span>
    </div>
  );
}
