import { useInfiniteQuery } from "@tanstack/react-query";
import {
    AlertTriangle,
    CheckCircle,
    ChevronDown,
    Clock,
    Loader2,
    XCircle,
} from "lucide-react";
import { useState } from "react";

import { Tag } from "@vellumai/design-library";

import { assistantsSystemEventsListInfiniteOptions } from "@/generated/api/@tanstack/react-query.gen";
import type {
    AssistantSystemEvent,
    EventStatusEnum,
    SystemEventTypeEnum,
} from "@/generated/api/types.gen";

type TagTone = "positive" | "negative" | "warning" | "neutral";

function formatEventType(type: SystemEventTypeEnum): string {
  switch (type) {
    case "lifecycle":
      return "Lifecycle";
    case "upgrade":
      return "Upgrade";
    case "rollback":
      return "Rollback";
    case "crash":
      return "Crash";
    case "idle_sleep":
      return "Idle Sleep";
    case "wake":
      return "Wake";
    case "profiler":
      return "Profiler";
    case "other":
      return "Other";
    default:
      return type;
  }
}

function formatEventStatus(status: EventStatusEnum): string {
  switch (status) {
    case "started":
      return "Started";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "in_progress":
      return "In Progress";
    default:
      return status;
  }
}

function isSuccessStatus(status: EventStatusEnum): boolean {
  return status === "succeeded";
}

function isFailureStatus(status: EventStatusEnum): boolean {
  return status === "failed";
}

function formatAbsoluteTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isLongSleep(event: AssistantSystemEvent): boolean {
  if (event.type !== "idle_sleep") {
    return false;
  }
  const details = event.details as Record<string, unknown> | null;
  const timeout = details?.["idle_timeout_seconds"];
  return typeof timeout === "number" && timeout >= 21600;
}

function eventTypeTone(
  type: SystemEventTypeEnum,
  event?: AssistantSystemEvent,
): TagTone {
  switch (type) {
    case "wake":
      return "positive";
    case "rollback":
      return "warning";
    case "crash":
      return "negative";
    case "idle_sleep":
      if (event && isLongSleep(event)) return "warning";
      return "neutral";
    case "lifecycle":
    case "upgrade":
    case "profiler":
    case "other":
    default:
      return "neutral";
  }
}

function EventTypeBadge({
  type,
  event,
}: {
  type: SystemEventTypeEnum;
  event?: AssistantSystemEvent;
}) {
  return <Tag tone={eventTypeTone(type, event)}>{formatEventType(type)}</Tag>;
}

function EventStatusBadge({ status }: { status: EventStatusEnum }) {
  const label = formatEventStatus(status);
  if (isSuccessStatus(status)) {
    return (
      <Tag tone="positive" leftIcon={<CheckCircle />}>
        {label}
      </Tag>
    );
  }
  if (isFailureStatus(status)) {
    return (
      <Tag tone="negative" leftIcon={<XCircle />}>
        {label}
      </Tag>
    );
  }
  return <Tag tone="neutral">{label}</Tag>;
}

function EventRow({ event }: { event: AssistantSystemEvent }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasDetails =
    event.details !== null &&
    event.details !== undefined &&
    Object.keys(event.details as object).length > 0;

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        background: "var(--surface-lift)",
        borderColor: "var(--border-base)",
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {event.display_text}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <EventTypeBadge type={event.type} event={event} />
            <EventStatusBadge status={event.event_status} />
            {isLongSleep(event) && (
              <Tag
                tone="warning"
                leftIcon={<AlertTriangle className="h-3 w-3" />}
              >
                Long sleep
              </Tag>
            )}
          </div>
        </div>
        <div
          className="text-body-small-default flex shrink-0 items-center gap-1.5"
          style={{ color: "var(--content-tertiary)" }}
        >
          <Clock className="h-3 w-3" />
          <span>{formatAbsoluteTimestamp(event.occurred_at)}</span>
        </div>
      </div>

      {hasDetails && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setDetailsOpen((o) => !o)}
            className="text-body-small-default flex items-center gap-1"
            style={{ color: "var(--content-tertiary)" }}
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
            />
            {detailsOpen ? "Hide details" : "Show details"}
          </button>
          {detailsOpen && (
            <pre
              className="mt-2 overflow-x-auto rounded-md p-3 text-body-small-default"
              style={{
                background: "var(--surface-base)",
                color: "var(--content-default)",
              }}
            >
              {JSON.stringify(event.details, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

interface SystemEventsTabProps {
  assistantId: string;
}

export function SystemEventsTab({ assistantId }: SystemEventsTabProps) {
  const {
    data,
    isLoading,
    isError,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    ...assistantsSystemEventsListInfiniteOptions({
      path: { assistant_id: assistantId },
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.next) return undefined;
      const loaded = allPages.reduce(
        (acc, page) => acc + page.results.length,
        0,
      );
      return loaded;
    },
  });

  const allEvents = data?.pages.flatMap((page) => page.results) ?? [];

  return (
    <div className="space-y-4">
      <p
        className="text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        Lifecycle events for your assistant from the last 30 days, newest
        first.
      </p>

      {isLoading ? (
        <div
          className="text-body-medium-lighter flex items-center gap-2"
          style={{ color: "var(--content-tertiary)" }}
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading system events...
        </div>
      ) : isError ? (
        <div
          className="text-body-medium-lighter flex items-center gap-2"
          style={{ color: "var(--system-negative-strong)" }}
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Failed to load system events. Please refresh and try again.
        </div>
      ) : allEvents.length === 0 ? (
        <p
          className="text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          No system events recorded in the last 30 days.
        </p>
      ) : (
        <div className="space-y-2">
          {allEvents.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}

          {hasNextPage && (
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="text-body-medium-default flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  borderColor: "var(--border-element)",
                  color: "var(--content-secondary)",
                }}
              >
                {isFetchingNextPage ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading older events...
                  </>
                ) : (
                  "Load older events"
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
