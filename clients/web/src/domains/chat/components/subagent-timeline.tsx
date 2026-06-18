
import {
    CircleCheck,
    MessageSquare,
    TriangleAlert,
    Wrench,
} from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { useTimelineVirtualizer } from "@/domains/chat/hooks/use-timeline-virtualizer";
import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";
import { Typography } from "@vellumai/design-library";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_COLLAPSED_LINES = 4;

/**
 * Connector line style — identical for every row, so hoist it to a stable
 * module-level object instead of allocating a new one on each render.
 */
const CONNECTOR_STYLE = {
  backgroundColor: "var(--border-subtle)",
  minHeight: 16,
};

/**
 * Constant style fields shared by every absolutely-positioned virtual row; only
 * the per-row `transform` is spread in at the call site, so these don't get
 * reallocated per row.
 */
const VIRTUAL_ROW_STYLE = {
  position: "absolute",
  top: 0,
  width: "100%",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether the content exceeds the collapsed line limit. */
function isContentLong(content: string): boolean {
  return content.split("\n").length > MAX_COLLAPSED_LINES;
}

/** Truncate content to the first N lines. */
function truncateContent(content: string): string {
  return content.split("\n").slice(0, MAX_COLLAPSED_LINES).join("\n");
}

// ---------------------------------------------------------------------------
// Filter: remove empty text events
// ---------------------------------------------------------------------------

function filterEvents(events: SubagentTimelineEvent[]): SubagentTimelineEvent[] {
  return events.filter((event) => {
    if (event.type === "text" && !event.content) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Icon node
// ---------------------------------------------------------------------------

function TimelineIcon({ event }: { event: SubagentTimelineEvent }) {
  const baseClass = "h-3 w-3 shrink-0";

  switch (event.type) {
    case "text":
      return (
        <MessageSquare
          className={baseClass}
          style={{ color: "var(--system-positive-strong)" }}
        />
      );
    case "tool_call":
      return (
        <Wrench
          className={baseClass}
          style={{ color: "var(--system-positive-strong)" }}
        />
      );
    case "tool_result":
      return event.isError ? (
        <TriangleAlert
          className={baseClass}
          style={{ color: "var(--system-negative-strong)" }}
        />
      ) : (
        <CircleCheck
          className={baseClass}
          style={{ color: "var(--system-positive-strong)" }}
        />
      );
    case "error":
      return (
        <TriangleAlert
          className={baseClass}
          style={{ color: "var(--system-negative-strong)" }}
        />
      );
    default:
      return (
        <MessageSquare
          className={baseClass}
          style={{ color: "var(--system-positive-strong)" }}
        />
      );
  }
}

function iconBgColor(event: SubagentTimelineEvent): string {
  if (event.type === "error" || (event.type === "tool_result" && event.isError)) {
    return "color-mix(in srgb, var(--system-negative-strong) 12%, transparent)";
  }
  return "var(--system-positive-weak)";
}

// ---------------------------------------------------------------------------
// Card title
// ---------------------------------------------------------------------------

function eventTitle(event: SubagentTimelineEvent): string {
  switch (event.type) {
    case "text":
      return "Response";
    case "tool_call":
      return "Tool Call";
    case "tool_result":
      return "Tool Result";
    case "error":
      return "Error";
    default:
      return "Response";
  }
}

// ---------------------------------------------------------------------------
// Collapsible text content
// ---------------------------------------------------------------------------

/**
 * Controlled collapsible text. Expand state is owned by {@link SubagentTimeline}
 * (keyed by `event.id`) rather than held locally here, so it survives this
 * component unmounting/remounting — the precondition for virtualizing the list.
 */
function CollapsibleContent({
  content,
  expanded,
  onToggle,
}: {
  content: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasLongContent = isContentLong(content);
  const displayContent = hasLongContent && !expanded
    ? truncateContent(content)
    : content;

  return (
    <>
      <Typography
        variant="body-medium-lighter"
        as="p"
        className="whitespace-pre-wrap break-words text-[var(--content-secondary)]"
      >
        {displayContent}
      </Typography>
      {hasLongContent && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-1 cursor-pointer hover:underline"
        >
          <Typography variant="body-small-default" className="text-[var(--content-default)]">
            {expanded ? "Show less" : "Show more"}
          </Typography>
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Timeline event row
// ---------------------------------------------------------------------------

const TimelineEventRow = memo(function TimelineEventRow({
  event,
  isLast,
  expanded,
  toggleExpand,
}: {
  event: SubagentTimelineEvent;
  isLast: boolean;
  expanded: boolean;
  /**
   * Stable across renders (see {@link SubagentTimeline}), so passing it through
   * `memo` doesn't defeat the row's bail-out. The per-row closure is bound at
   * the call site below rather than by the parent, to keep this prop stable.
   */
  toggleExpand: (id: string) => void;
}) {
  return (
    // The inter-row gap lives in this row's `pb-4` padding (not the card's
    // margin): the virtualizer measures rows via `getBoundingClientRect`, which
    // excludes margins, so a margin-based gap would make absolutely-positioned
    // rows overlap. As padding it's part of the measured height, and the
    // connector's `flex-1` fill still spans through it to the next row.
    <div className="relative flex gap-3 pb-4">
      {/* Left: icon node + connector line */}
      <div className="flex flex-col items-center">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: iconBgColor(event) }}
        >
          <TimelineIcon event={event} />
        </div>
        {!isLast && (
          <div className="w-0.5 flex-1 rounded-full" style={CONNECTOR_STYLE} />
        )}
      </div>

      {/* Right: content card */}
      <div className="min-w-0 flex-1 rounded-lg bg-[var(--surface-overlay)] px-4 py-3">
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-default)]"
        >
          {eventTitle(event)}
        </Typography>

        {/* Tool Call: show tool name + content */}
        {event.type === "tool_call" && (
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
            {event.toolName && (
              <Typography
                variant="body-medium-lighter"
                className="min-w-0 break-words text-[var(--content-tertiary)]"
              >
                {event.toolName}
              </Typography>
            )}
            {event.content && (
              <Typography
                variant="body-medium-lighter"
                className="min-w-0 break-words text-[var(--content-tertiary)]"
              >
                {event.content}
              </Typography>
            )}
          </div>
        )}

        {/* Response / Tool Result: show text content */}
        {(event.type === "text" || event.type === "tool_result") && event.content && (
          <div className="mt-1">
            {event.isError ? (
              <Typography
                variant="body-medium-lighter"
                as="p"
                className="whitespace-pre-wrap break-words text-[var(--system-negative-strong)]"
              >
                {event.content}
              </Typography>
            ) : (
              <CollapsibleContent
                content={event.content}
                expanded={expanded}
                onToggle={() => toggleExpand(event.id)}
              />
            )}
          </div>
        )}

        {/* Error: show error text */}
        {event.type === "error" && event.content && (
          <div className="mt-1">
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="whitespace-pre-wrap break-words text-[var(--system-negative-strong)]"
            >
              {event.content}
            </Typography>
          </div>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface SubagentTimelineProps {
  events: SubagentTimelineEvent[];
  /**
   * The panel's scroll container. The list virtualizes against this *external*
   * element (not its own box) so the metrics/objective header above the list
   * scrolls together with the rows.
   */
  scrollRef: RefObject<HTMLElement | null>;
}

export const SubagentTimeline = memo(function SubagentTimeline({
  events,
  scrollRef,
}: SubagentTimelineProps) {
  const filteredEvents = useMemo(() => filterEvents(events), [events]);

  // Expand/collapse state lives here, keyed by `event.id`, so it survives a row
  // unmounting and remounting as the virtualizer windows the list. `toggleExpand`
  // is stable across renders so it can be passed through the `memo`'d row without
  // defeating its bail-out.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // The list element, used by the virtualizer to offset virtual positions
  // (`scrollMargin`) relative to the scroll container's content.
  const listRef = useRef<HTMLDivElement>(null);
  // Memoized so the virtualizer's options don't churn on every render (e.g.
  // expand/collapse); only reallocates when the event list itself changes.
  const getItemKey = useCallback(
    (index: number) => filteredEvents[index]!.id,
    [filteredEvents],
  );
  const virtualizer = useTimelineVirtualizer({
    count: filteredEvents.length,
    scrollRef,
    listRef,
    getItemKey,
  });

  if (filteredEvents.length === 0) {
    return (
      <Typography
        variant="body-small-default"
        className="py-4 text-center text-[var(--content-tertiary)]"
      >
        No events yet
      </Typography>
    );
  }

  return (
    <div ref={listRef} className="flex flex-col">
      {/* Spacer reserves the full list height (via `getTotalSize`) so the
          scrollbar reflects all rows even though only a window is mounted. */}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const event = filteredEvents[vi.index]!;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                ...VIRTUAL_ROW_STYLE,
                transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              <TimelineEventRow
                event={event}
                // Absolute index, not the position within the rendered window,
                // so the connector is omitted only for the genuine last row.
                isLast={vi.index === filteredEvents.length - 1}
                expanded={expandedIds.has(event.id)}
                toggleExpand={toggleExpand}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
