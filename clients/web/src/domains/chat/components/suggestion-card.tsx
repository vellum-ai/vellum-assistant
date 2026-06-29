import { ArrowRight } from "lucide-react";

import { SuggestionIcon } from "@/domains/chat/suggestions/suggestion-icon";
import type { ThreadSuggestion } from "@/domains/chat/suggestions/types";
import { cn } from "@/utils/misc";

/**
 * A clickable card for the new-thread suggestions library: the suggestion's
 * resolved icon, its title, and a trailing arrow, stacked and centered on a
 * flat overlay surface. Selecting the card (click or keyboard) opens its
 * detail drawer via `onSelect`.
 */
export interface SuggestionCardProps {
  suggestion: ThreadSuggestion;
  onSelect: (suggestion: ThreadSuggestion) => void;
}

export function SuggestionCard({ suggestion, onSelect }: SuggestionCardProps) {
  return (
    <button
      type="button"
      data-slot="suggestion-card"
      aria-label={`Open suggestion: ${suggestion.title}`}
      onClick={() => onSelect(suggestion)}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-4 text-center",
        "rounded-2xl px-4 py-6",
        "bg-[var(--surface-overlay)] text-[color:var(--content-default)]",
        "transition-colors hover:bg-[var(--surface-lift)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-base)] focus-visible:ring-offset-2",
      )}
    >
      <SuggestionIcon iconKey={suggestion.iconKey} size={40} />
      <span className="text-title-small">{suggestion.title}</span>
      <ArrowRight
        aria-hidden
        className="h-3.5 w-3.5 text-[var(--content-tertiary)]"
      />
    </button>
  );
}
