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
import type { RemovalReason } from "@/domains/chat/onboarding-research/research-facts";

export interface ResearchResultsViewProps {
  mode: "loading" | "results" | "empty";
  /** What to render in the loading state (live activity feed, or a mock). */
  loadingContent: ReactNode;
  items: ResearchFactItem[];
  removals: ReadonlyMap<number, RemovalReason | null>;
  suggestions: string[];
  resultsTitle: string;
  showDeeperDiveCard: boolean;
  showSuggestions: boolean;
  canContinue: boolean;
  resolveFavicon: (domain: string) => string;
  onRemove: (index: number) => void;
  onSetReason: (index: number, reason: RemovalReason) => void;
  onRestore: (index: number) => void;
  onDeeperDive: () => void;
  onGoodForNow: () => void;
  onSuggestionClick: (suggestion: string) => void;
  onContinue: () => void;
}

export function ResearchResultsView({
  mode,
  loadingContent,
  items,
  removals,
  suggestions,
  resultsTitle,
  showDeeperDiveCard,
  showSuggestions,
  canContinue,
  resolveFavicon,
  onRemove,
  onSetReason,
  onRestore,
  onDeeperDive,
  onGoodForNow,
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
              {showDeeperDiveCard ? (
                <div className="flex flex-col items-start gap-3 rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] px-5 py-4">
                  <p className="text-[15px] text-[var(--content-secondary)]">
                    I can search more, just didn&apos;t want to be too intrusive.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" size="regular" onClick={onDeeperDive}>
                      Yes, do a deeper dive
                    </Button>
                    <Button variant="outlined" size="regular" onClick={onGoodForNow}>
                      This is good for now
                    </Button>
                  </div>
                </div>
              ) : null}
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
