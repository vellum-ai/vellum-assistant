/**
 * Pure presentational layout for the research-onboarding results step.
 *
 * SPIKE — research-onboarding flow.
 *
 * Store-free and side-effect-free: every piece of data and every action is a
 * prop. Shared by the live overlay (`research-results-overlay.tsx`, which wires
 * the chat/turn stores in) and the mock harness page
 * (`research-mock-page.tsx`, which wires static fixtures + local state in) so
 * the two can't drift while we iterate on UI/UX.
 */

import type { ReactNode } from "react";

import { Button } from "@vellumai/design-library/components/button";

import {
  ResearchFactsCard,
  type ResearchFactItem,
} from "@/domains/chat/onboarding-research/research-facts-card";
import { ResearchSuggestions } from "@/domains/chat/onboarding-research/research-suggestions";
import type {
  RemovalReason,
  ResearchSuggestion,
} from "@/domains/chat/onboarding-research/research-facts";

export interface ResearchResultsViewProps {
  mode: "loading" | "results" | "empty";
  /** What to render in the loading state (live activity feed, or a mock). */
  loadingContent: ReactNode;
  items: ResearchFactItem[];
  removals: ReadonlyMap<number, RemovalReason | null>;
  suggestions: ResearchSuggestion[];
  resultsTitle: string;
  showSuggestions: boolean;
  canContinue: boolean;
  resolveFavicon: (domain: string) => string;
  onRemove: (index: number) => void;
  onSetReason: (index: number, reason: RemovalReason) => void;
  onRestore: (index: number) => void;
  onSuggestionClick: (prompt: string) => void;
  onContinue: () => void;
}

export function ResearchResultsView({
  mode,
  loadingContent,
  items,
  removals,
  suggestions,
  resultsTitle,
  showSuggestions,
  canContinue,
  resolveFavicon,
  onRemove,
  onSetReason,
  onRestore,
  onSuggestionClick,
  onContinue,
}: ResearchResultsViewProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-[var(--surface-base)]">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-8 px-6 py-12">
        <div className="flex flex-1 flex-col justify-start gap-8 pt-4">
          {mode === "results" ? (
            <>
              <ResearchFactsCard
                items={items}
                removals={removals}
                onRemove={onRemove}
                onSetReason={onSetReason}
                onRestore={onRestore}
                resolveFavicon={resolveFavicon}
                title={resultsTitle}
              />
              {showSuggestions ? (
                <ResearchSuggestions
                  suggestions={suggestions}
                  onSelect={onSuggestionClick}
                />
              ) : null}
            </>
          ) : mode === "empty" ? (
            <div className="flex flex-col items-center gap-3 text-center text-[var(--content-secondary)]">
              <p className="text-lg text-[var(--content-default)]">
                Let&apos;s just dive in.
              </p>
              <p className="text-body-medium-lighter">
                I couldn&apos;t pull together a clean profile this time — we can
                get to know each other as we go.
              </p>
            </div>
          ) : (
            loadingContent
          )}
        </div>

        <div className="flex shrink-0 justify-end">
          <Button
            variant="primary"
            size="regular"
            onClick={onContinue}
            disabled={!canContinue}
            className="h-11 px-6 text-base"
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
