/**
 * Mock harness for the research-onboarding results UI.
 *
 * SPIKE — research-onboarding flow. Route: /assistant/onboarding/research-mock
 *
 * Renders the exact same `ResearchResultsView` as the live overlay, driven by
 * static fixtures + local state instead of the chat/turn stores — so we can
 * iterate on layout, copy, and the remove / suggestion-click interactions
 * instantly, without running the real (slow) research job.
 *
 * Suggestion clicks use the real navigation path, so this also reproduces the
 * "start a new conversation with the message sent" behavior in isolation.
 */

import { useState } from "react";
import { Navigate, useNavigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";
import { ResearchResultsView } from "@/domains/chat/onboarding-research/research-results-view";
import type {
  RemovalReason,
  ResearchFact,
  ResearchSuggestion,
} from "@/domains/chat/onboarding-research/research-facts";

// Fictional fixture — no real names/handles/identifying data (root AGENTS.md);
// this file is bundled into a public client chunk. Shaped to exercise the UI:
// varied confidence, claims with one / multiple / no sources, and a long claim
// that wraps. Real domains are used only for favicon variety.
const MOCK_CLAIMS: ResearchFact[] = [
  {
    claim: "Software engineer based in Austin, TX",
    confidence: "confident",
    sources: ["https://github.com/example-dev"],
  },
  {
    claim: "Product engineer at an early-stage AI startup",
    confidence: "confident",
    sources: ["https://example.com/team"],
  },
  {
    claim:
      "Maintains an open-source CLI tool for local LLM evaluation and tooling",
    confidence: "confident",
    sources: ["https://github.com/example-dev", "https://example.com/project"],
  },
  {
    claim: "Primarily writes TypeScript and Go",
    confidence: "confident",
    sources: ["https://github.com/example-dev"],
  },
  {
    claim: "Came up through a coding bootcamp rather than a CS degree",
    confidence: "maybe",
    sources: [],
  },
];

const MOCK_SUGGESTIONS: ResearchSuggestion[] = [
  {
    suggestion: "I'll summarize this week's AI model releases for you",
    prompt: "Summarize this week's AI model releases for me.",
  },
  {
    suggestion: "I'll draft a technical blog post from your latest notes",
    prompt: "Draft a technical blog post from my latest notes.",
  },
  {
    suggestion: "I'll build you a tracker for competitor product launches",
    prompt: "Build me a tracker for competitor product launches.",
  },
  {
    suggestion: "I'll analyze a CSV of metrics and surface the trends",
    prompt: "Analyze a CSV of metrics for me and surface the trends.",
  },
];

function faviconService(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

type Mode = "loading" | "results" | "empty";

export function ResearchMockPage() {
  const navigate = useNavigate();
  const enabled = useClientFeatureFlagStore.use.researchOnboarding();
  const [mode, setMode] = useState<Mode>("results");
  const [removals, setRemovals] = useState<Map<number, RemovalReason | null>>(
    () => new Map(),
  );

  const items = MOCK_CLAIMS.map((fact, index) => ({ fact, index }));

  const handleSuggestionClick = (suggestion: string) => {
    const draftId = createDraftConversationId();
    useConversationStore.getState().setActiveConversationId(draftId);
    void navigate(
      `${routes.conversation(draftId)}?prompt=${encodeURIComponent(suggestion)}`,
    );
  };

  if (!enabled) {
    return <Navigate to={routes.assistant} replace />;
  }

  return (
    <div className="relative h-screen w-screen">
      {/* Dev-only state switcher — not part of the real flow. */}
      <div className="absolute left-1/2 top-3 z-50 flex -translate-x-1/2 gap-1 rounded-full border border-[var(--border-base)] bg-[var(--surface-lift)] p-1">
        {(["loading", "results", "empty"] as Mode[]).map((m) => (
          <Button
            key={m}
            variant={mode === m ? "primary" : "ghost"}
            size="compact"
            onClick={() => setMode(m)}
          >
            {m}
          </Button>
        ))}
      </div>

      <ResearchResultsView
        mode={mode}
        loadingContent={
          <div className="text-[var(--content-secondary)]">
            <p className="text-lg">Getting to know you…</p>
            <p className="text-body-medium-lighter">
              (mock — the live flow shows the search activity feed here)
            </p>
          </div>
        }
        items={items}
        removals={removals}
        suggestions={MOCK_SUGGESTIONS}
        resultsTitle="Here's what I know about you. You can remove any that aren't true:"
        showSuggestions
        canContinue
        resolveFavicon={faviconService}
        onRemove={(index) =>
          setRemovals((prev) =>
            prev.has(index) ? prev : new Map(prev).set(index, null),
          )
        }
        onSetReason={(index, reason) =>
          setRemovals((prev) => new Map(prev).set(index, reason))
        }
        onRestore={(index) =>
          setRemovals((prev) => {
            if (!prev.has(index)) return prev;
            const next = new Map(prev);
            next.delete(index);
            return next;
          })
        }
        onSuggestionClick={handleSuggestionClick}
        onContinue={() => navigate(routes.assistant)}
      />
    </div>
  );
}
