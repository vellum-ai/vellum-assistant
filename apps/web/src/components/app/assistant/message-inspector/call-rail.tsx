
import { AppLink, type AppRoute } from "@/adapters/app-link.js";
import { type ReactNode } from "react";

import {
  displayProvider,
  displayText,
  formattedCreatedAt,
  MISSING_VALUE,
} from "@/domains/chat/lib/inspector-formatters.js";
import type { LLMRequestLogEntry } from "@/domains/chat/lib/inspector-types.js";

interface CallRailProps {
  logs: LLMRequestLogEntry[];
  selectedLogId: string | undefined;
  /**
   * Builds the inspector URL for a given log id. The rail renders each
   * row as a real hyperlink (right-click → open in new tab works, the
   * URL is sharable, browser back/forward navigates between calls).
   */
  buildCallHref: (logId: string) => AppRoute;
}

/**
 * Left rail listing every LLM call captured for the inspected message.
 * Web port of the call rail in macOS's `MessageInspectorView`
 * (`callRow(entry:index:)`).
 *
 * Sort order: newest call on top, oldest on the bottom. The `Call N`
 * label tracks display position (Call 1 = the row at the top of the
 * rail). Selection is encoded in the URL via `?callId=...`, so each
 * row is a real anchor — sharable, right-click-openable, and
 * back/forward navigable across calls.
 */
export function CallRail({
  logs,
  selectedLogId,
  buildCallHref,
}: CallRailProps): ReactNode {
  if (!logs.length) {
    return (
      <div
        className="flex h-full items-center justify-center p-4 text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        No LLM calls recorded.
      </div>
    );
  }

  const orderedLogs = [...logs].reverse();

  return (
    <nav className="flex flex-col gap-2 p-3" aria-label="LLM calls">
      <div
        className="px-1 text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {logs.length === 1 ? "1 LLM call" : `${logs.length} LLM calls`}
      </div>
      {orderedLogs.map((entry, displayIndex) => (
        <CallRow
          key={entry.id}
          entry={entry}
          index={displayIndex}
          isSelected={entry.id === selectedLogId}
          isLatest={displayIndex === 0}
          href={buildCallHref(entry.id)}
        />
      ))}
    </nav>
  );
}

interface CallRowProps {
  entry: LLMRequestLogEntry;
  index: number;
  isSelected: boolean;
  isLatest: boolean;
  href: AppRoute;
}

function CallRow({
  entry,
  index,
  isSelected,
  isLatest,
  href,
}: CallRowProps): ReactNode {
  const provider = displayProvider(entry.summary?.provider ?? null);
  const model = entry.summary?.model
    ? displayText(entry.summary.model)
    : null;
  const subtitle =
    [provider !== MISSING_VALUE ? provider : null, model]
      .filter((value): value is string => Boolean(value))
      .join(" · ") || "Unrecognized call";

  return (
    <AppLink
      href={href}
      aria-current={isSelected ? "page" : undefined}
      className="flex flex-col gap-1 rounded-md p-3 text-left no-underline transition-colors hover:opacity-90"
      style={{
        background: isSelected
          ? "var(--surface-active)"
          : "var(--surface-overlay)",
        border: `1px solid ${
          isSelected ? "var(--border-active)" : "var(--border-base)"
        }`,
      }}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="line-clamp-1 flex-1 text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Call {index + 1}
        </span>
        {isLatest ? (
          <span
            className="text-label-default"
            style={{ color: "var(--primary-default, var(--content-default))" }}
          >
            Latest
          </span>
        ) : null}
      </div>
      <div
        className="line-clamp-2 text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {subtitle}
      </div>
      <div
        className="text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {formattedCreatedAt(entry.createdAt)}
      </div>
    </AppLink>
  );
}
