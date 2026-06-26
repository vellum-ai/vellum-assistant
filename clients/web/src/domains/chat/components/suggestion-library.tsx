import { ChevronDown } from "lucide-react";

import { SuggestionCard } from "@/domains/chat/components/suggestion-card";
import type {
  SuggestionGroup,
  ThreadSuggestion,
} from "@/domains/chat/suggestions/types";

/**
 * The new-thread suggestions library: an always-visible featured row, a
 * "scroll down to see more" affordance, and the full set of categorized
 * groups below the fold. Layout-only — it does not own the outer scroll
 * container; the empty-state scroll area provides that.
 */
export interface SuggestionLibraryProps {
  /** The always-visible featured row (typically 3 cards). */
  featured: ThreadSuggestion[];
  /** Full categorized library shown below the featured row. */
  groups: SuggestionGroup[];
  onSelect: (suggestion: ThreadSuggestion) => void;
}

export function SuggestionLibrary({
  featured,
  groups,
  onSelect,
}: SuggestionLibraryProps) {
  return (
    <div data-slot="suggestion-library" className="flex flex-col gap-8">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {featured.map((suggestion) => (
          <SuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            onSelect={onSelect}
          />
        ))}
      </div>

      <div className="flex flex-col items-center gap-1 text-[var(--content-tertiary)]">
        <span className="text-label-small-default">
          Scroll down to see more
        </span>
        <ChevronDown aria-hidden className="h-4 w-4" />
      </div>

      {groups.map((group) => (
        <section key={group.id} className="flex flex-col gap-3">
          <h3 className="text-title-small text-[var(--content-default)]">
            {group.title}
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {group.suggestions.map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
