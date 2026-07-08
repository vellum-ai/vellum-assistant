import { Button } from "@vellumai/design-library";
import { CheckCircle2, Play, Puzzle, X } from "lucide-react";

import { SuggestionIcon } from "@/domains/chat/suggestions/suggestion-icon";
import type {
  SuggestionRequirement,
  ThreadSuggestion,
} from "@/domains/chat/suggestions/types";
import { cn } from "@/utils/misc";

interface SuggestionDetailPanelProps {
  suggestion: ThreadSuggestion;
  onClose: () => void;
  onConfirm: (suggestion: ThreadSuggestion) => void;
}

/**
 * Presentational drawer content for a single {@link ThreadSuggestion}: a
 * centered icon + title header with a close button, the description, the
 * required connections/skills as pills, the list of things the assistant can
 * do, and a pinned "Let's do it!" footer.
 *
 * Renders inside a drawer, so it fills the full height and keeps the body
 * scrollable while the header and footer stay pinned.
 */
export function SuggestionDetailPanel({
  suggestion,
  onClose,
  onConfirm,
}: SuggestionDetailPanelProps) {
  const { iconKey, detail } = suggestion;

  return (
    <div
      data-slot="suggestion-detail-panel"
      className="flex h-full flex-col bg-[var(--surface-overlay)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-[var(--surface-base)] p-4">
        <div className="flex min-w-0 items-center gap-2">
          <SuggestionIcon iconKey={iconKey} size={24} />
          <h2 className="truncate text-title-small text-[var(--content-default)]">
            {detail.heading}
          </h2>
        </div>
        <Button
          variant="outlined"
          size="compact"
          iconOnly={<X aria-hidden />}
          aria-label="Close"
          onClick={onClose}
        />
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto p-4">
        <p className="text-body-medium-default text-[var(--content-secondary)]">
          {detail.description}
        </p>

        <section className="space-y-3">
          <h3 className="text-title-small text-[var(--content-default)]">
            Here&apos;s what we&apos;ll need:
          </h3>
          <ul className="flex flex-col items-start gap-2">
            {detail.requirements.map((requirement) => (
              <RequirementPill key={requirement.id} requirement={requirement} />
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <h3 className="text-title-small text-[var(--content-default)]">
            Things we can do:
          </h3>
          <ul className="list-disc space-y-1.5 pl-5 text-body-medium-default text-[var(--content-secondary)]">
            {detail.capabilities.map((capability) => (
              <li key={capability}>{capability}</li>
            ))}
          </ul>
        </section>
      </div>

      <footer className="flex justify-end gap-2 border-t border-[var(--surface-base)] p-4">
        <Button
          variant="primary"
          leftIcon={<Play aria-hidden className="h-3.5 w-3.5" fill="currentColor" />}
          onClick={() => onConfirm(suggestion)}
        >
          Let&apos;s do it!
        </Button>
      </footer>
    </div>
  );
}

/**
 * A single required connection or skill, rendered as a pill: green when it's
 * already satisfied, gray (with a muted install hint) when it still needs to
 * be connected or installed.
 */
function RequirementPill({
  requirement,
}: {
  requirement: SuggestionRequirement;
}) {
  const isReady = requirement.status === "ready";

  return (
    <li
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-2 text-body-medium-default",
        isReady
          ? "bg-[var(--system-positive-weak)] text-[var(--system-positive-strong)]"
          : "bg-[var(--surface-base)] text-[var(--content-default)]",
      )}
    >
      {isReady ? (
        <CheckCircle2 aria-hidden size={18} className="shrink-0" />
      ) : (
        <Puzzle
          aria-hidden
          size={18}
          className="shrink-0 text-[var(--content-secondary)]"
        />
      )}
      <span className="inline-flex items-center gap-1.5">
        <span>{requirement.label}</span>
        {!isReady && requirement.hint ? (
          <>
            <span aria-hidden className="text-[var(--content-tertiary)]">
              ·
            </span>
            <span className="text-[var(--content-tertiary)]">
              {requirement.hint}
            </span>
          </>
        ) : null}
      </span>
    </li>
  );
}
