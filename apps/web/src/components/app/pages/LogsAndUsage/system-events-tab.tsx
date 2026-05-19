
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, ChevronDown, Clock, Loader2, XCircle } from "lucide-react";
import { useState } from "react";

import { Card } from "@vellum/design-library/components/card";
import { Tag, type TagTone } from "@vellum/design-library/components/tag";
import { assistantsSystemEventsListInfiniteOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import type { AssistantSystemEvent, EventStatusEnum, SystemEventTypeEnum } from "@/generated/api/types.gen.js";

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Human-readable label for each type value. */
export function formatEventType(type: SystemEventTypeEnum): string {
  switch (type) {
    case "lifecycle": return "Lifecycle";
    case "upgrade": return "Upgrade";
    case "rollback": return "Rollback";
    case "crash": return "Crash";
    case "idle_sleep": return "Idle Sleep";
    case "wake": return "Wake";
    case "profiler": return "Profiler";
    case "other": return "Other";
    default: return type;
  }
}

/** Human-readable label for each event_status value. */
export function formatEventStatus(status: EventStatusEnum): string {
  switch (status) {
    case "started": return "Started";
    case "succeeded": return "Succeeded";
    case "failed": return "Failed";
    case "in_progress": return "In Progress";
    default: return status;
  }
}

/** True for terminal success statuses. */
export function isSuccessStatus(status: EventStatusEnum): boolean {
  return status === "succeeded";
}

/** True for failure statuses. */
export function isFailureStatus(status: EventStatusEnum): boolean {
  return status === "failed";
}

/** Format an ISO timestamp as a human-readable absolute date + time. */
export function formatAbsoluteTimestamp(iso: string): string {
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EventTypeBadge({ type, event }: { type: SystemEventTypeEnum; event?: AssistantSystemEvent }) {
  return <Tag tone={eventTypeTone(type, event)}>{formatEventType(type)}</Tag>;
}

function eventTypeTone(type: SystemEventTypeEnum, event?: AssistantSystemEvent): TagTone {
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

/** True when an idle_sleep event has an idle timeout policy >= 6 hours. */
function isLongSleep(event: AssistantSystemEvent): boolean {
  if (event.type !== "idle_sleep") {
    return false;
  }
  const details = event.details as Record<string, unknown> | null;
  const timeout = details?.["idle_timeout_seconds"];
  return typeof timeout === "number" && timeout >= 21600;
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
  const hasDetails = event.details !== null && event.details !== undefined && Object.keys(event.details as object).length > 0;

  return (
    <Card.Root>
      <Card.Body padding="sm" className="px-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-body-medium-default text-[var(--content-default)]">
            {event.display_text}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <EventTypeBadge type={event.type} event={event} />
            <EventStatusBadge status={event.event_status} />
            {isLongSleep(event) && (
              <Tag tone="warning" leftIcon={<AlertTriangle className="h-3 w-3" />}>
                Long sleep
              </Tag>
            )}
          </div>
        </div>
        <div className="text-body-small-default flex shrink-0 items-center gap-1.5 text-[var(--content-tertiary)]">
          <Clock className="h-3 w-3" />
          <span>{formatAbsoluteTimestamp(event.occurred_at)}</span>
        </div>
      </div>

      {hasDetails && (
        <div className="mt-2">
          <button
            onClick={() => setDetailsOpen((o) => !o)}
            className="text-body-small-default flex items-center gap-1 text-[var(--content-tertiary)] hover:text-[var(--content-default)] dark:text-[var(--content-disabled)] dark:hover:text-[var(--content-default)]"
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
            />
            {detailsOpen ? "Hide details" : "Show details"}
          </button>
          {/* off-scale: mono 12/400 (JSON details payload — pre inherits monospace) */}
          {detailsOpen && (
            <pre className="mt-2 overflow-x-auto rounded-md bg-[var(--surface-base)] p-3 text-body-small-default text-[var(--content-default)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]">
              {JSON.stringify(event.details, null, 2)}
            </pre>
          )}
        </div>
      )}
      </Card.Body>
    </Card.Root>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

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
      const loaded = allPages.reduce((acc, page) => acc + page.results.length, 0);
      return loaded;
    },
  });

  const allEvents = data?.pages.flatMap((page) => page.results) ?? [];

  return (
    <div className="space-y-4">
      <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
        Lifecycle events for your assistant from the last 30 days, newest first.
      </p>

      {isLoading ? (
        <div className="text-body-medium-lighter flex items-center gap-2 text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading system events...
        </div>
      ) : isError ? (
        <div className="text-body-medium-lighter flex items-center gap-2 text-red-600 dark:text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Failed to load system events. Please refresh and try again.
        </div>
      ) : allEvents.length === 0 ? (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
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
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="text-body-medium-default flex w-full items-center justify-center gap-2 rounded-md border border-[var(--border-element)] px-4 py-2 text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-base)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[var(--border-element)] dark:text-[var(--content-default)] dark:hover:bg-[var(--ghost-hover)]"
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
