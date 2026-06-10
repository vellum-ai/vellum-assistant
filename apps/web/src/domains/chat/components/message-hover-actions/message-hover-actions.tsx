
import { Check, Copy, ExternalLink, FileCode, GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { segmentsToPlainText } from "@/domains/chat/utils/segments-to-plain-text";

type MessageHoverActionsProps = {
  /** The message whose text is copied and whose role/timestamp drive the row. */
  message: DisplayMessage;
  /** Slack permalink for the message, shown as a hover action when present. */
  openInSlackUrl?: string;
  /** Callback when "Fork from here" is clicked. */
  onFork?: () => void;
  /** Callback when "Inspect" is clicked. */
  onInspect?: () => void;
};

function formatTimestamp(epoch: number): string {
  const date = new Date(epoch);
  const now = new Date();

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  if (isToday) {
    return `Today, ${timeStr}`;
  }

  const dayStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${dayStr}, ${timeStr}`;
}

function formatDetailedTimestamp(epoch: number): string {
  return new Date(epoch).toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  });
}

/**
 * Latest activity timestamp for a message: the max of the message's own
 * timestamp and any tool-call start/completion times, so the displayed time
 * reflects when the row last did something rather than when it was created.
 */
function latestMessageActivityTimestamp(
  message: DisplayMessage,
): number | undefined {
  const latestToolTimestamp = message.toolCalls?.reduce<number | undefined>(
    (latest, toolCall) => {
      const toolTimestamp = toolCall.completedAt ?? toolCall.startedAt;
      if (toolTimestamp == null) {
        return latest;
      }
      return latest == null ? toolTimestamp : Math.max(latest, toolTimestamp);
    },
    undefined,
  );

  if (latestToolTimestamp == null) {
    return message.timestamp;
  }

  if (message.timestamp == null) {
    return latestToolTimestamp;
  }

  return Math.max(message.timestamp, latestToolTimestamp);
}

export function MessageHoverActions({
  message,
  openInSlackUrl,
  onFork,
  onInspect,
}: MessageHoverActionsProps) {
  const { role } = message;
  // Flat plain-text body derived from the ordered text segments; this is the
  // copy payload and mirrors the daemon's `joinWithSpacing`.
  const content = useMemo(
    () => segmentsToPlainText(message.textSegments),
    [message.textSegments],
  );
  const timestamp = useMemo(
    () => latestMessageActivityTimestamp(message),
    [message],
  );

  const [showCopied, setShowCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable fallback so history messages (which lack a client-side timestamp)
  // still display one without re-computing on every render.
  const [fallbackTimestamp] = useState(() => Date.now());
  const displayTimestamp = timestamp ?? fallbackTimestamp;

  const hasCopyableText = content.trim().length > 0;

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setShowCopied(true);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        setShowCopied(false);
        timerRef.current = null;
      }, 1500);
    }).catch(() => {
      // Clipboard write denied — silently ignore
    });
  }, [content]);

  return (
    <div
      className={`flex items-center gap-0.5 ${
        role === "user" ? "justify-end" : "justify-start"
      }`}
    >
      <span
        className="select-none px-1 text-body-small-default text-[var(--content-tertiary)]"
        title={formatDetailedTimestamp(displayTimestamp)}
      >
        {formatTimestamp(displayTimestamp)}
      </span>

      {hasCopyableText && (
        <button
          type="button"
          onClick={handleCopy}
          title={showCopied ? "Copied" : "Copy"}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          {showCopied ? (
            <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      {openInSlackUrl && (
        <a
          href={openInSlackUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Open in Slack"
          title="Open in Slack"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}

      {onFork && (
        <button
          type="button"
          onClick={onFork}
          title="Fork from here"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          <GitBranch className="h-3.5 w-3.5" />
        </button>
      )}

      {onInspect && (
        <button
          type="button"
          onClick={onInspect}
          title="Inspect"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          <FileCode className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
