import { Button } from "@vellumai/design-library";
import { CheckCircle2, Puzzle, X } from "lucide-react";

import { SuggestionIcon } from "@/domains/chat/suggestions/suggestion-icon";
import type {
  SuggestionRequirement,
  ThreadSuggestion,
} from "@/domains/chat/suggestions/types";

interface SuggestionDetailPanelProps {
  suggestion: ThreadSuggestion;
  onClose: () => void;
  onSaveForLater: (suggestion: ThreadSuggestion) => void;
  onConfirm: (suggestion: ThreadSuggestion) => void;
}

/**
 * Presentational drawer content for a single {@link ThreadSuggestion}: header,
 * description, requirements, capabilities, and a pinned Save/Confirm footer.
 *
 * Renders inside a drawer, so it fills the full height and keeps the body
 * scrollable while the footer stays pinned at the bottom.
 */
export function SuggestionDetailPanel({
  suggestion,
  onClose,
  onSaveForLater,
  onConfirm,
}: SuggestionDetailPanelProps) {
  const { iconKey, detail } = suggestion;

  return (
    <div data-slot="suggestion-detail-panel" className="flex h-full flex-col">
      <header className="flex items-start gap-3 px-5 pt-5">
        <SuggestionIcon iconKey={iconKey} />
        <h2 className="flex-1 text-title-medium-default text-[var(--content-default)]">
          {detail.heading}
        </h2>
        <Button
          variant="ghost"
          iconOnly={<X aria-hidden />}
          aria-label="Close"
          onClick={onClose}
        />
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
        <p className="text-body-medium-default text-[var(--content-secondary)]">
          {detail.description}
        </p>

        <section className="space-y-3">
          <h3 className="text-label-medium-default text-[var(--content-tertiary)]">
            Here&apos;s what we&apos;ll need:
          </h3>
          <ul className="space-y-2">
            {detail.requirements.map((requirement) => (
              <RequirementRow key={requirement.id} requirement={requirement} />
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <h3 className="text-label-medium-default text-[var(--content-tertiary)]">
            Things we can do:
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-body-medium-default text-[var(--content-secondary)]">
            {detail.capabilities.map((capability) => (
              <li key={capability}>{capability}</li>
            ))}
          </ul>
        </section>
      </div>

      <footer className="flex justify-end gap-2 border-t border-[var(--border-base)] px-5 py-4">
        <Button variant="outlined" onClick={() => onSaveForLater(suggestion)}>
          Save for Later
        </Button>
        <Button variant="primary" onClick={() => onConfirm(suggestion)}>
          Let&apos;s do it!
        </Button>
      </footer>
    </div>
  );
}

function RequirementRow({
  requirement,
}: {
  requirement: SuggestionRequirement;
}) {
  const isReady = requirement.status === "ready";

  return (
    <li className="flex items-start gap-2 text-body-medium-default">
      {isReady ? (
        <CheckCircle2
          aria-hidden
          size={18}
          className="mt-0.5 shrink-0 text-[var(--system-positive-strong)]"
        />
      ) : (
        <Puzzle
          aria-hidden
          size={18}
          className="mt-0.5 shrink-0 text-[var(--content-tertiary)]"
        />
      )}
      <span className="flex flex-col">
        <span
          className={
            isReady
              ? "text-[var(--content-default)]"
              : "text-[var(--content-secondary)]"
          }
        >
          {requirement.label}
        </span>
        {!isReady && requirement.hint ? (
          <span className="text-body-small-default text-[var(--content-tertiary)]">
            {requirement.hint}
          </span>
        ) : null}
      </span>
    </li>
  );
}
