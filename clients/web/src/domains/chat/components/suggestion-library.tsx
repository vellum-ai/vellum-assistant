import { ChevronDown } from "lucide-react";

import { SuggestionCard } from "@/domains/chat/components/suggestion-card";
import type {
  SuggestionGroup,
  ThreadSuggestion,
} from "@/domains/chat/suggestions/types";

/**
 * The new-thread suggestions library, split into two pieces so the empty
 * state can dock the featured row to the bottom of the first viewport and
 * push the categorized groups below the fold:
 *
 * - {@link SuggestionFeaturedRow} — the always-visible featured cards plus the
 *   "scroll down to see more" affordance.
 * - {@link SuggestionGroups} — the full set of categorized groups, revealed on
 *   scroll.
 *
 * {@link SuggestionLibrary} renders both stacked, for callers (and tests) that
 * want the whole library in one slot.
 */

interface FeaturedRowProps {
  /** The always-visible featured row (typically 3 cards). */
  featured: ThreadSuggestion[];
  onSelect: (suggestion: ThreadSuggestion) => void;
}

export function SuggestionFeaturedRow({ featured, onSelect }: FeaturedRowProps) {
  return (
    <div data-slot="suggestion-featured-row" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {featured.map((suggestion) => (
          <SuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            onSelect={onSelect}
          />
        ))}
      </div>

      <div className="flex items-center justify-center gap-2 text-[var(--content-tertiary)]">
        <ChevronDown aria-hidden className="h-5 w-5" />
        <span className="text-body-small-default">Scroll down to see more</span>
      </div>
    </div>
  );
}

interface GroupsProps {
  /** Full categorized library shown below the featured row. */
  groups: SuggestionGroup[];
  onSelect: (suggestion: ThreadSuggestion) => void;
}

export function SuggestionGroups({ groups, onSelect }: GroupsProps) {
  return (
    <div data-slot="suggestion-groups" className="flex flex-col gap-8">
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
      <SuggestionFeaturedRow featured={featured} onSelect={onSelect} />
      <SuggestionGroups groups={groups} onSelect={onSelect} />
    </div>
  );
}
