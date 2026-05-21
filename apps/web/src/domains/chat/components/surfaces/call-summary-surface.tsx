
import { ChevronDown, ChevronRight, Phone, PhoneMissed, PhoneOff } from "lucide-react";
import { useState } from "react";

import type { Surface } from "@/domains/chat/types/types.js";

interface CallEvent {
  eventType: string;
  payloadJson: string;
  createdAt: number;
}

interface CallSummaryData {
  status?: string;
  duration?: number | null;
  events?: CallEvent[];
}

function prettifyEventType(eventType: string): string {
  return eventType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function CallSummarySurface({
  surface,
  // Call summaries are always display-only — no actions are ever emitted.
  // onAction is accepted to satisfy the SurfaceRouter contract but unused.
}: {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { status, duration, events = [] } = surface.data as CallSummaryData;

  const statusLabel =
    status === "failed"
      ? "Call failed"
      : status === "cancelled"
        ? "Call cancelled"
        : "Call completed";
  const durationStr = duration != null ? ` (${duration}s)` : "";

  const StatusIcon =
    status === "failed"
      ? PhoneMissed
      : status === "cancelled"
        ? PhoneOff
        : Phone;

  return (
    <div className="rounded-lg border border-stone-200 bg-[var(--surface-lift)] dark:border-moss-600">
      <button
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-stone-50 dark:hover:bg-moss-600 rounded-lg"
        onClick={() => setExpanded((v) => !v)}
      >
        <StatusIcon className="h-4 w-4 shrink-0 text-[var(--content-faint)]" />
        <span className="flex-1 text-body-medium-lighter text-[var(--content-strong)]">
          <strong>{statusLabel}</strong>
          {durationStr}
          {". "}
          {events.length} event{events.length !== 1 ? "s" : ""} recorded.
        </span>
        {events.length > 0 &&
          (expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-stone-400" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-stone-400" />
          ))}
      </button>

      {expanded && events.length > 0 && (
        <div className="border-t border-stone-100 dark:border-moss-600 px-3 py-2 space-y-1">
          {events.map((e, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 py-1"
            >
              <span className="text-body-small-default font-mono text-stone-600 dark:text-stone-400">
                {prettifyEventType(e.eventType)}
              </span>
              <span className="text-body-small-default text-[var(--content-faint)] shrink-0">
                {new Date(e.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
