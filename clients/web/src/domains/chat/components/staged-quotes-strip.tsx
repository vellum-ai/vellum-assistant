/**
 * Renders the list of staged quote-replies above the composer. Each chip
 * shows a truncated preview of the quoted text and the user's annotation,
 * with an X button to remove it.
 *
 * The strip is scrollable when multiple quotes are staged, capped at
 * 120 px so it never dominates the viewport.
 */

import { MessageSquareQuote, X } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  Button,
  Card,
  Typography,
} from "@vellumai/design-library";
import {
  quoteBlockquoteAccentClassName,
  quoteBlockquoteClassName,
  quoteBlockquoteContentClassName,
} from "@vellumai/design-library/components/markdown-message";

import {
  type StagedQuote,
  useQuoteReplyStore,
} from "@/domains/chat/quote-reply-store";

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}…`;
}

function StagedQuoteChip({ quote }: { quote: StagedQuote }) {
  const removeStagedQuote = useQuoteReplyStore.use.removeStagedQuote();

  return (
    <Card.Root
      padding="sm"
      bordered
      className="group/quote bg-[var(--surface-lift)]"
    >
      <Card.Body padding="sm" className="flex items-start gap-2">
        <MessageSquareQuote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" />
        <div className="min-w-0 flex-1">
          <Typography
            as="div"
            variant="body-small-default"
            className={`${quoteBlockquoteClassName} mb-0`}
          >
            <span
              aria-hidden="true"
              className={quoteBlockquoteAccentClassName}
            />
            <span className={quoteBlockquoteContentClassName}>
              {truncate(quote.quotedText, 80)}
            </span>
          </Typography>
          <Typography
            as="div"
            variant="body-small-default"
            className="mt-0.5 text-[var(--content-default)]"
          >
            {truncate(quote.replyText, 120)}
          </Typography>
        </div>
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          expandOnMobile={false}
          onClick={() => removeStagedQuote(quote.id)}
          className="shrink-0 opacity-0 transition-opacity group-hover/quote:opacity-100 focus-visible:opacity-100"
          aria-label="Remove quote"
        />
      </Card.Body>
    </Card.Root>
  );
}

export function StagedQuotesStrip() {
  const stagedQuotes = useQuoteReplyStore.use.stagedQuotes();
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(stagedQuotes.length);

  // When a quote is appended, bring the newest chip into view — otherwise a
  // new reply lands below the 120px cap and the strip silently stays scrolled
  // to the top. Only scroll on growth so removing a chip doesn't yank the view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stagedQuotes.length > prevCountRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevCountRef.current = stagedQuotes.length;
  }, [stagedQuotes.length]);

  if (stagedQuotes.length === 0) {
    return null;
  }

  return (
    <div ref={scrollRef} className="mb-2 max-h-[120px] overflow-y-auto">
      <div className="flex flex-col gap-1.5">
        {stagedQuotes.map((quote) => (
          <StagedQuoteChip key={quote.id} quote={quote} />
        ))}
      </div>
    </div>
  );
}
