
import {
    CircleCheck,
    MessageSquare,
    TriangleAlert,
    Wrench,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

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

function CollapsibleContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
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
          onClick={() => setExpanded((prev) => !prev)}
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
}: {
  event: SubagentTimelineEvent;
  isLast: boolean;
}) {
  return (
    // `content-visibility: auto` lets the browser skip layout/paint for rows
    // that are off-screen in the panel's scroll container; `contain-intrinsic-
    // size: auto 72px` reserves a placeholder (and remembers each row's real
    // size once measured) so the scrollbar doesn't jump.
    <div className="relative flex gap-3 [content-visibility:auto] [contain-intrinsic-size:auto_72px]">
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
      <div className="mb-4 min-w-0 flex-1 rounded-lg bg-[var(--surface-overlay)] px-4 py-3">
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
              <CollapsibleContent content={event.content} />
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
}

export function SubagentTimeline({ events }: SubagentTimelineProps) {
  const filteredEvents = useMemo(() => filterEvents(events), [events]);

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
    <div className="flex flex-col">
      {filteredEvents.map((event, index) => (
        <TimelineEventRow
          key={event.id}
          event={event}
          isLast={index === filteredEvents.length - 1}
        />
      ))}
    </div>
  );
}
