/**
 * Focused-onboarding results overlay.
 *
 * SPIKE — research-onboarding flow.
 *
 * Rendered by `ChatLayout` (over the live `ActiveChatView`, which drives the
 * hatch → mint → auto-send → stream pipeline) whenever the onboarding focus
 * flag is set. It reads the conversation transcript from the chat session
 * store and parses the assistant's `{ claims, suggestions }` reply
 * *incrementally* — each claim and suggestion surfaces as its element finishes
 * streaming. A "dig deeper" action sends a follow-up research turn whose result
 * overwrites both. Source favicons resolve from the live web-search results.
 *
 * The underlying chat is intentionally covered; Continue lands the user on the
 * same conversation. Lives in the chat domain because it reads chat state.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { routes } from "@/utils/routes";
import { ResearchActivityFeed } from "@/domains/chat/onboarding-research/research-activity-feed";
import { ResearchResultsView } from "@/domains/chat/onboarding-research/research-results-view";
import {
  buildDeeperDivePrompt,
  buildRemovalNote,
  type RemovedClaim,
} from "@/domains/chat/onboarding-research/deeper-dive-prompt";
import {
  extractMessageText,
  latestAssistantMessage,
  parseResearchResultStreaming,
  type RemovalReason,
  type ResearchFact,
} from "@/domains/chat/onboarding-research/research-facts";

/** Most claims to show — keeps the card from becoming a wall of text. */
const MAX_CLAIMS = 5;
/** Settled-with-nothing must persist this long before we show the empty state,
 *  so a transient idle (e.g. the gap before `turn_started`) can't flash it. */
const EMPTY_DEBOUNCE_MS = 2500;

function faviconService(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export function ResearchResultsOverlay() {
  const messages = useChatSessionStore((s) => s.messages);
  const turnPhase = useTurnStore((s) => s.phase);
  const liveWebActivity = useTurnStore((s) => s.liveWebActivity);
  const exitFocus = useOnboardingFocusStore.use.exitFocus();
  const requestFollowup = useOnboardingFocusStore.use.requestFollowup();
  const navigate = useNavigate();

  const processing = isSending(turnPhase);

  // The auto-send fires a beat after mount, so at first paint the turn is still
  // `idle` with no facts. Track whether a turn has actually started (sticky).
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (processing) setStarted(true);
  }, [processing]);

  // Assistant reply text so far ("" until the assistant actually streams).
  const assistantText = useMemo(() => {
    const assistant = latestAssistantMessage(messages);
    return assistant ? extractMessageText(assistant) : "";
  }, [messages]);
  const hasAssistantText = assistantText.trim().length > 0;

  // Incremental parse of `{ claims, suggestions }` — grows as each streams in.
  const live = useMemo(
    () => parseResearchResultStreaming(assistantText),
    [assistantText],
  );

  // Frozen snapshot — set when the user accepts the result ("This is good for
  // now"). The follow-up correction we then send gets a non-JSON reply that
  // would otherwise re-parse to nothing and wipe the card, so once frozen we
  // render the snapshot instead of the live parse.
  const [frozen, setFrozen] = useState<{
    claims: ResearchFact[];
    suggestions: string[];
  } | null>(null);
  const claims = frozen ? frozen.claims : live.claims;
  const suggestions = frozen ? frozen.suggestions : live.suggestions;
  const hasFacts = claims.length > 0;

  // Removed claims: index → reason (null until/unless one is chosen). Rows stay
  // visible but greyed — nothing is filtered out, so removal isn't abrupt.
  const [removals, setRemovals] = useState<Map<number, RemovalReason | null>>(
    () => new Map(),
  );
  const handleRemove = (index: number) =>
    setRemovals((prev) => {
      if (prev.has(index)) return prev;
      return new Map(prev).set(index, null);
    });
  const handleSetReason = (index: number, reason: RemovalReason) =>
    setRemovals((prev) => new Map(prev).set(index, reason));
  const handleRestore = (index: number) =>
    setRemovals((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Map(prev);
      next.delete(index);
      return next;
    });
  const visibleItems = claims
    .map((fact, index) => ({ fact, index }))
    .slice(0, MAX_CLAIMS);

  // Removed claims as a structured list for the background correction.
  const collectRemoved = (): RemovedClaim[] =>
    [...removals.entries()]
      .filter(([index]) => index < claims.length)
      .map(([index, reason]) => ({ claim: claims[index]!.claim, reason }));

  // Accumulate real favicons (domain → url) from live search/fetch activity.
  const [faviconByDomain, setFaviconByDomain] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    setFaviconByDomain((prev) => {
      const next = { ...prev };
      let changed = false;
      const add = (domain?: string, fav?: string) => {
        if (domain && fav && !next[domain]) {
          next[domain] = fav;
          changed = true;
        }
      };
      for (const meta of Object.values(liveWebActivity)) {
        meta.webSearch?.results?.forEach((r) => add(r.domain, r.faviconUrl));
        if (meta.webFetch) add(meta.webFetch.domain, meta.webFetch.faviconUrl);
      }
      return changed ? next : prev;
    });
  }, [liveWebActivity]);
  const resolveFavicon = (domain: string) =>
    faviconByDomain[domain] ?? faviconService(domain);

  // Empty state requires the assistant to have actually produced text (so the
  // warm-up / pre-stream gap never counts), debounced against transient idles.
  const emptyCandidate =
    started && !processing && !hasFacts && hasAssistantText;
  const [showEmpty, setShowEmpty] = useState(false);
  useEffect(() => {
    if (!emptyCandidate) {
      setShowEmpty(false);
      return;
    }
    const t = setTimeout(() => setShowEmpty(true), EMPTY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [emptyCandidate]);

  // The deeper-dive prompt is resolved once the user picks either option; the
  // card then goes away for good and the suggestions are revealed. Sticky.
  const [deeperDiveResolved, setDeeperDiveResolved] = useState(false);

  // Deeper-dive: bridge the gap between click and the turn actually starting so
  // the button can't be double-fired.
  const [divePending, setDivePending] = useState(false);
  useEffect(() => {
    if (processing) setDivePending(false);
  }, [processing]);
  const handleDeeperDive = () => {
    if (processing || divePending) return;
    const removed = collectRemoved();
    setDivePending(true);
    setDeeperDiveResolved(true);
    setRemovals(new Map()); // a fresh result set is coming — drop stale removals
    requestFollowup(buildDeeperDivePrompt(removed));
  };
  const handleGoodForNow = () => {
    const removed = collectRemoved();
    // Lock the current result so the correction's reply can't wipe it.
    setFrozen({ claims: live.claims, suggestions: live.suggestions });
    setDeeperDiveResolved(true);
    if (removed.length > 0) requestFollowup(buildRemovalNote(removed));
  };

  // Clicking a suggestion starts a fresh conversation with that message sent on
  // the user's behalf, then drops them out of the focused flow into it.
  const handleSuggestionClick = (suggestion: string) => {
    const draftId = createDraftConversationId();
    useConversationStore.getState().setActiveConversationId(draftId);
    void navigate(
      `${routes.conversation(draftId)}?prompt=${encodeURIComponent(suggestion)}`,
    );
    exitFocus();
  };

  const settled = started && !processing && !divePending;
  // Once frozen (accepted) the result is final even while the background
  // correction turn runs, so show the settled title and allow continue.
  const locked = frozen != null;
  const mode: "loading" | "results" | "empty" = hasFacts
    ? "results"
    : showEmpty
      ? "empty"
      : "loading";

  return (
    <div className="fixed inset-0 z-50">
      <ResearchResultsView
        mode={mode}
        loadingContent={<ResearchActivityFeed />}
        items={visibleItems}
        removals={removals}
        suggestions={suggestions}
        resultsTitle={
          settled || locked
            ? "Here's what I know about you. You can remove any that aren't true:"
            : "Getting to know you…"
        }
        showDeeperDiveCard={settled && !deeperDiveResolved}
        showSuggestions={deeperDiveResolved && suggestions.length > 0}
        canContinue={!processing || locked}
        resolveFavicon={resolveFavicon}
        onRemove={handleRemove}
        onSetReason={handleSetReason}
        onRestore={handleRestore}
        onDeeperDive={handleDeeperDive}
        onGoodForNow={handleGoodForNow}
        onSuggestionClick={handleSuggestionClick}
        onContinue={exitFocus}
      />
    </div>
  );
}
