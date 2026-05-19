import { icons, Sparkles, X } from "lucide-react";
import { useState } from "react";

import { Typography } from "@vellum/design-library";
import type { SuggestedPrompt } from "./types.js";

function toPascalCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolves a daemon icon key (bare Lucide camelCase like "mail", "fileText")
 * to a lucide-react component. Matches the macOS resolveIcon(_:) algorithm:
 * try direct PascalCase lookup, then strip "lucide-" prefix and retry.
 */
function resolveIcon(iconName: string | undefined) {
  if (!iconName) return Sparkles;

  const pascal = toPascalCase(iconName);
  if (icons[pascal as keyof typeof icons]) {
    return icons[pascal as keyof typeof icons];
  }

  const stripped = iconName.replace(/^lucide-/, "");
  if (stripped !== iconName) {
    const strippedPascal = toPascalCase(stripped);
    if (icons[strippedPascal as keyof typeof icons]) {
      return icons[strippedPascal as keyof typeof icons];
    }
  }

  return Sparkles;
}

interface HomeSuggestionPillBarProps {
  suggestions: SuggestedPrompt[];
  onSelect: (prompt: SuggestedPrompt) => void;
}

export function HomeSuggestionPillBar({
  suggestions,
  onSelect,
}: HomeSuggestionPillBarProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || suggestions.length === 0) return null;

  const visible = suggestions.slice(0, 3);

  return (
    <div className="flex flex-col gap-[var(--app-spacing-sm)] rounded-2xl border border-[var(--border-disabled)] px-[var(--app-spacing-lg)] py-[var(--app-spacing-lg)]">
      <div className="flex items-center justify-between">
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-tertiary)]"
        >
          By the way, have you tried one of these:
        </Typography>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss suggestions"
          className="shrink-0 cursor-pointer text-[var(--content-disabled)] transition-colors hover:text-[var(--content-tertiary)]"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-[var(--app-spacing-sm)]">
        {visible.map((suggestion) => {
          const Icon = resolveIcon(suggestion.icon);
          return (
            <button
              key={suggestion.id}
              type="button"
              onClick={() => onSelect(suggestion)}
              className="flex cursor-pointer items-center gap-[var(--app-spacing-xs)] rounded-full bg-[var(--surface-active)] py-1 pl-1 pr-3 text-[var(--content-default)] transition-colors hover:text-[var(--content-secondary)]"
            >
              <span
                className="flex shrink-0 items-center justify-center rounded-full bg-[var(--surface-active)]"
                style={{ width: 26, height: 26 }}
                aria-hidden="true"
              >
                <Icon className="size-[9px]" />
              </span>
              <span className="text-body-small-default">
                {suggestion.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
