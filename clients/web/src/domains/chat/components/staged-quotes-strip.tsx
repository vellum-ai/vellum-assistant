/**
 * Renders the list of staged quote-replies above the composer. Each chip
 * shows a truncated preview of the quoted text and the user's annotation,
 * with an X button to remove it.
 *
 * The strip is scrollable when multiple quotes are staged, capped at
 * 120 px so it never dominates the viewport.
 */

import { MessageSquareQuote, X } from "lucide-react";

import {
  type StagedQuote,
  useQuoteReplyStore,
} from "@/domains/chat/quote-reply-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}…`;
}

function StagedQuoteChip({ quote }: { quote: StagedQuote }) {
  const removeStagedQuote = useQuoteReplyStore.use.removeStagedQuote();

  return (
    <div className="group/quote flex items-start gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-lift)] px-3 py-2">
      <MessageSquareQuote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" />
      <div className="min-w-0 flex-1">
        <div className="text-body-small-default text-[var(--content-tertiary)]">
          &ldquo;{truncate(quote.quotedText, 80)}&rdquo;
        </div>
        <div className="mt-0.5 text-body-small-default text-[var(--content-default)]">
          {truncate(quote.replyText, 120)}
        </div>
      </div>
      <button
        type="button"
        onClick={() => removeStagedQuote(quote.id)}
        className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--content-tertiary)] opacity-0 transition-opacity group-hover/quote:opacity-100"
        aria-label="Remove quote"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function StagedQuotesStrip() {
  const quoteReplyEnabled = useClientFeatureFlagStore.use.quoteReply();
  const stagedQuotes = useQuoteReplyStore.use.stagedQuotes();

  if (!quoteReplyEnabled || stagedQuotes.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 max-h-[120px] overflow-y-auto">
      <div className="flex flex-col gap-1.5">
        {stagedQuotes.map((quote) => (
          <StagedQuoteChip key={quote.id} quote={quote} />
        ))}
      </div>
    </div>
  );
}
