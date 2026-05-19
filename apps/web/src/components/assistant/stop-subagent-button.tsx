import { Square } from "lucide-react";

export interface StopSubagentButtonProps {
  subagentId: string;
  label: string;
  onClick: (subagentId: string) => void;
  /** When true, render a text label next to the icon. */
  showLabel?: boolean;
}

/**
 * Shared stop button for aborting a running subagent.
 * Calls `e.stopPropagation()` internally so it works safely inside
 * clickable parent rows/cards.
 */
export function StopSubagentButton({
  subagentId,
  label,
  onClick,
  showLabel = false,
}: StopSubagentButtonProps) {
  return (
    <button
      type="button"
      aria-label={`Stop ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick(subagentId);
      }}
      className={`flex shrink-0 items-center justify-center rounded border border-[var(--system-negative-strong)] text-[var(--system-negative-strong)] transition-colors hover:bg-[color-mix(in_srgb,var(--system-negative-strong)_10%,transparent)] ${
        showLabel ? "px-2 py-1 text-label-small-default" : "h-6 w-6"
      }`}
    >
      <Square
        className={showLabel ? "mr-1 h-2.5 w-2.5" : "h-2.5 w-2.5"}
        fill="currentColor"
      />
      {showLabel && "Stop"}
    </button>
  );
}
