import { CircleAlert } from "lucide-react";

// ---------------------------------------------------------------------------
// ThreadStatusIndicator — trailing status glyph for thread rows
// ---------------------------------------------------------------------------

export interface ThreadStatusIndicatorProps {
  isProcessing?: boolean;
  needsAttention?: boolean;
  hasUnread?: boolean;
}

/**
 * Whether a thread row has any status worth showing. Callers gate on this
 * before rendering so an idle row passes no badge at all (an empty badge
 * slot would still paint its pill chrome).
 */
export function hasThreadStatus({
  isProcessing,
  needsAttention,
  hasUnread,
}: ThreadStatusIndicatorProps): boolean {
  return Boolean(needsAttention || isProcessing || hasUnread);
}

/**
 * Status glyph for a thread row's badge slot (priority order):
 *
 *   Needs attention → Exclamation circle (warning color, no pulse).
 *   Processing      → Pulsing dot (animate-pulse, primary-base).
 *   Unread          → Static dot (system-mid-strong).
 */
export function ThreadStatusIndicator({
  isProcessing,
  needsAttention,
  hasUnread,
}: ThreadStatusIndicatorProps) {
  if (needsAttention) {
    return (
      <CircleAlert
        size={14}
        aria-hidden
        className="text-[var(--system-mid-strong)]"
      />
    );
  }
  if (isProcessing) {
    return (
      <span
        aria-hidden
        className="h-2 w-2 rounded-full bg-[var(--primary-base)] animate-pulse"
      />
    );
  }
  if (hasUnread) {
    return (
      <span
        aria-hidden
        className="h-2 w-2 rounded-full bg-[var(--system-mid-strong)]"
      />
    );
  }
  return null;
}
