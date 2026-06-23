/**
 * Assistant-proposed actions surfaced alongside the research claims.
 *
 * SPIKE — research-onboarding flow.
 *
 * Presentational: renders the (up to 4) things the assistant suggests it could
 * do for the user. Cards fly in as they stream and are overwritten wholesale
 * when a deeper-dive run returns a richer set.
 */

import { Sparkles } from "lucide-react";

import type { ResearchSuggestion } from "@/domains/chat/onboarding-research/research-facts";

interface ResearchSuggestionsProps {
  suggestions: ResearchSuggestion[];
  /** Start a new conversation with the user-voiced prompt sent on their behalf. */
  onSelect: (prompt: string) => void;
}

export function ResearchSuggestions({
  suggestions,
  onSelect,
}: ResearchSuggestionsProps) {
  if (suggestions.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-3">
      <h2 className="text-lg font-medium text-[var(--content-secondary)]">
        Here&apos;s how I could help to start:
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {suggestions.slice(0, 4).map((suggestion, index) => (
          <button
            key={`${index}-${suggestion.suggestion}`}
            type="button"
            onClick={() => onSelect(suggestion.prompt)}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-3 text-left transition-colors hover:border-[var(--border-element)] hover:bg-[var(--surface-base)]"
            style={{ animation: "fadeInUp 0.35s ease-out both" }}
          >
            <Sparkles className="size-4 shrink-0 text-[var(--content-tertiary)]" />
            <span className="text-[15px] leading-snug text-[var(--content-default)]">
              {suggestion.suggestion}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
