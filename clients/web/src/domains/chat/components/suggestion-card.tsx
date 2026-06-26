import { SuggestionIcon } from "@/domains/chat/suggestions/suggestion-icon";
import type { ThreadSuggestion } from "@/domains/chat/suggestions/types";
import { cn } from "@/utils/misc";

/**
 * A clickable card for the new-thread suggestions library: the suggestion's
 * resolved icon centered above its title, on an elevated rounded surface.
 * Selecting the card (click or keyboard) opens its detail drawer via
 * `onSelect`.
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
        "flex flex-col items-center justify-center gap-3 text-center",
        "rounded-xl px-6 py-5",
        "bg-[var(--surface-lift)] text-[color:var(--content-default)]",
        "shadow-sm transition hover:-translate-y-0.5 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-base)] focus-visible:ring-offset-2",
      )}
    >
      <SuggestionIcon iconKey={suggestion.iconKey} />
      <span className="text-body-medium-default">{suggestion.title}</span>
    </button>
  );
}
