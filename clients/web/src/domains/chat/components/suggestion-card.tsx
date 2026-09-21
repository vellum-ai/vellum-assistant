import { Card } from "@vellumai/design-library";
import { ArrowRight } from "lucide-react";

import { useTranslation } from "@/i18n";

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
  const { t } = useTranslation("chat");
  return (
    <Card.Root
      asChild
      interactive
      bordered={false}
      noPadding
      className={cn(
        "flex flex-col items-center justify-center gap-4 text-center",
        "rounded-2xl px-4 py-6",
        // A flat overlay tile that lifts on hover, one step below Card's own
        // resting fill.
        "bg-[var(--surface-overlay)] hover:bg-[var(--surface-lift)]",
      )}
    >
      <button
        type="button"
        data-slot="suggestion-card"
        aria-label={t("suggestionCard.openAria", { title: suggestion.title })}
        onClick={() => onSelect(suggestion)}
      >
        <SuggestionIcon iconKey={suggestion.iconKey} size={40} />
        <span className="text-title-small">{suggestion.title}</span>
        <ArrowRight
          aria-hidden
          className="h-3.5 w-3.5 text-[var(--content-tertiary)]"
        />
      </button>
    </Card.Root>
  );
}
