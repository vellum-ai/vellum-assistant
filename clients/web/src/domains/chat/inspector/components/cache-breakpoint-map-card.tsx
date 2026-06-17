/**
 * Cache breakpoint-map panel for the Prompt tab. Renders the ordered
 * cache segments of an Anthropic request — the chunks delimited by the
 * `cache_control` markers, in the provider's cache-prefix order (tools →
 * system → messages) — as a vertical map of sized rows, each coloured by
 * whether it was read from cache or re-created this turn. It shows where
 * the cache boundaries fell and which part of the prefix busted.
 *
 * The raw request payload (which carries the `cache_control` markers) is
 * omitted from the summary-view list endpoint, so this component fetches
 * it on demand via {@link useLlmLogPayload}. All parsing lives in the pure
 * {@link parseCacheBreakpoints} helper; this component owns only fetching
 * and presentation.
 */

import { type ReactNode } from "react";

import {
  parseCacheBreakpoints,
  type CacheBreakpointSegment,
  type CacheSegmentStatus,
} from "@/domains/chat/inspector/cache-breakpoints";
import { useLlmLogPayload } from "@/domains/chat/inspector/inspector-payload-api";
import { formatCount } from "@/domains/chat/inspector/inspector-formatters";
import type { LLMRequestLogEntry } from "@vellumai/assistant-api";
import { Card, Notice, Tag } from "@vellumai/design-library";

export interface CacheBreakpointMapCardProps {
  entry: LLMRequestLogEntry;
  assistantId: string | undefined;
}

const STATUS_COLOR: Record<CacheSegmentStatus, string> = {
  read: "var(--system-positive-strong)",
  created: "var(--system-mid-strong)",
  unknown: "var(--content-faint)",
};

const STATUS_LABEL: Record<CacheSegmentStatus, string> = {
  read: "Read from cache",
  created: "Re-created",
  unknown: "Cached",
};

interface StateNoteProps {
  children: ReactNode;
}

/** Titled card used for the loading / error / disabled states. */
function StateNote({ children }: StateNoteProps): ReactNode {
  return (
    <Card>
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        Cache breakpoints
      </p>
      <p
        className="mt-1 text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        {children}
      </p>
    </Card>
  );
}

interface LegendItemProps {
  status: CacheSegmentStatus;
}

function LegendItem({ status }: LegendItemProps): ReactNode {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-label-default"
      style={{ color: "var(--content-secondary)" }}
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: STATUS_COLOR[status] }}
      />
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}

interface SegmentRowProps {
  segment: CacheBreakpointSegment;
  widthPercent: number;
}

function SegmentRow({ segment, widthPercent }: SegmentRowProps): ReactNode {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: STATUS_COLOR[segment.status] }}
          />
          <span
            className="truncate text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {segment.label}
          </span>
          {segment.ttl ? (
            <Tag tone="neutral">{segment.ttl}</Tag>
          ) : null}
        </span>
        <span
          className="shrink-0 text-label-default tabular-nums"
          style={{ color: "var(--content-secondary)" }}
        >
          ≈ {formatCount(segment.estimatedTokens)} tokens
        </span>
      </div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full"
        style={{ background: "var(--surface-base)" }}
      >
        <span
          style={{
            width: `${widthPercent}%`,
            background: STATUS_COLOR[segment.status],
          }}
        />
      </div>
      {segment.detail ? (
        <span
          className="text-label-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {segment.detail}
        </span>
      ) : null}
    </li>
  );
}

/**
 * Renders the breakpoint map, or nothing when the call isn't an Anthropic
 * request (so callers can drop it in unconditionally).
 */
export function CacheBreakpointMapCard({
  entry,
  assistantId,
}: CacheBreakpointMapCardProps): ReactNode {
  const provider = (entry.summary?.provider ?? entry.provider)?.toLowerCase();
  const model = entry.summary?.model;
  const isAnthropic =
    provider === "anthropic" || (model?.startsWith("claude-") ?? false);

  const {
    data: payload,
    isLoading,
    isError,
  } = useLlmLogPayload(
    isAnthropic ? assistantId : undefined,
    isAnthropic ? entry.id : undefined,
  );

  if (!isAnthropic) {
    return null;
  }

  if (isLoading) {
    return (
      <StateNote>
        Loading the request payload to map cache breakpoints…
      </StateNote>
    );
  }
  if (isError) {
    return (
      <StateNote>
        Couldn&apos;t load the request payload to map cache breakpoints.
      </StateNote>
    );
  }

  const map = parseCacheBreakpoints(payload?.requestPayload, entry.summary);
  if (!map) {
    return null;
  }

  if (map.segments.length === 0) {
    return (
      <StateNote>
        This request carried no cache breakpoints — prompt caching was disabled
        for the call.
      </StateNote>
    );
  }

  const maxTokens = Math.max(
    ...map.segments.map((segment) => segment.estimatedTokens),
    1,
  );
  const statuses = new Set(map.segments.map((segment) => segment.status));
  const fullMiss =
    map.readTokens != null && map.readTokens <= 0 && map.segments.length > 0;

  return (
    <Card>
      <div className="min-w-0">
        <p
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Cache breakpoints
        </p>
        <p
          className="mt-1 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          Where the {map.segments.length} cache breakpoint
          {map.segments.length === 1 ? "" : "s"} fell across this request&apos;s
          prefix, and which segments were read versus re-created.
        </p>
      </div>

      {statuses.size > 0 && !statuses.has("unknown") ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {statuses.has("read") ? <LegendItem status="read" /> : null}
          {statuses.has("created") ? <LegendItem status="created" /> : null}
        </div>
      ) : null}

      <ol className="mt-3 flex flex-col gap-3">
        {map.segments.map((segment) => (
          <SegmentRow
            key={segment.key}
            segment={segment}
            widthPercent={Math.max(
              (segment.estimatedTokens / maxTokens) * 100,
              2,
            )}
          />
        ))}
      </ol>

      {fullMiss ? (
        <div className="mt-3">
          <Notice tone="warning" title="Full cache miss">
            Every segment was re-created this turn. Compare with the previous
            turn in the cache diff above to find the block that changed.
          </Notice>
        </div>
      ) : null}

      <p
        className="mt-3 text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        Token counts are estimated from text length.
        {map.splitEstimated
          ? " The read/created split is attributed by segment size; the provider reports only the totals."
          : ""}
      </p>
    </Card>
  );
}
