
import { Check, Copy, FileCode, GitBranch } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type MessageHoverActionsProps = {
  /** The message text content for copy functionality. */
  content: string;
  /** Epoch-ms timestamp. Sourced from the server API when available,
   *  otherwise set client-side when the message is first created. */
  timestamp?: number;
  /** The role of the message sender. */
  role: "user" | "assistant";
  /** Whether the message is currently streaming. */
  isStreaming?: boolean;
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

export function MessageHoverActions({
  content,
  timestamp,
  role,
  isStreaming,
  onFork,
  onInspect,
}: MessageHoverActionsProps) {
  const [showCopied, setShowCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable fallback so history messages (which lack a client-side timestamp)
  // still display one without re-computing on every render.
  const [fallbackTimestamp] = useState(() => Date.now());
  const displayTimestamp = timestamp ?? fallbackTimestamp;

  const hasCopyableText = content.trim().length > 0;
  const isAssistant = role === "assistant";
  const hasAnyAction = hasCopyableText || onFork || (onInspect && isAssistant);

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

  if (!hasAnyAction || isStreaming) {
    return null;
  }

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
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-stone-200 hover:text-[var(--content-secondary)] dark:hover:bg-moss-600 dark:hover:text-stone-200"
        >
          {showCopied ? (
            <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      {onFork && (
        <button
          type="button"
          onClick={onFork}
          title="Fork from here"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-stone-200 hover:text-[var(--content-secondary)] dark:hover:bg-moss-600 dark:hover:text-stone-200"
        >
          <GitBranch className="h-3.5 w-3.5" />
        </button>
      )}

      {onInspect && isAssistant && (
        <button
          type="button"
          onClick={onInspect}
          title="Inspect"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-stone-200 hover:text-[var(--content-secondary)] dark:hover:bg-moss-600 dark:hover:text-stone-200"
        >
          <FileCode className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
