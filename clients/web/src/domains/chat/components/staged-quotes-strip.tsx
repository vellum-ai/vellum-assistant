/**
 * Renders the list of staged quote-replies above the composer. Each chip
 * shows a truncated preview of the quoted text and an editable reply field
 * (kept in sync with the store so replies can be revised after staging),
 * with an X button to remove it.
 *
 * The strip is scrollable when multiple quotes are staged, capped at
 * 120 px so it never dominates the viewport.
 */

import { X } from "lucide-react";
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
  const updateStagedQuoteReply = useQuoteReplyStore.use.updateStagedQuoteReply();
  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the reply field to fit its content.
  useEffect(() => {
    const el = replyRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [quote.replyText]);

  return (
    <Card.Root
      padding="sm"
      bordered
      className="group/quote bg-[var(--surface-lift)]"
    >
      <Card.Body padding="md" className="relative flex flex-col gap-2 pr-8">
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
        <textarea
          ref={replyRef}
          value={quote.replyText}
          onChange={(e) =>
            updateStagedQuoteReply(quote.id, e.target.value)
          }
          rows={1}
          placeholder="Type your reply…"
          aria-label="Edit reply"
          className="w-full resize-none overflow-hidden border-none bg-transparent p-0 text-body-medium-lighter text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:outline-none"
        />
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          expandOnMobile={false}
          onClick={() => removeStagedQuote(quote.id)}
          className="absolute right-1 top-1 shrink-0 opacity-0 transition-opacity group-hover/quote:opacity-100 focus-visible:opacity-100"
          aria-label="Remove quote"
        />
      </Card.Body>
    </Card.Root>
  );
}

export function StagedQuotesStrip() {
  const stagedQuotes = useQuoteReplyStore.use.stagedQuotes();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(stagedQuotes.length);

  // When a quote is added, scroll the strip to the newest chip so it never
  // lands silently below the fold. Deferred a frame so the freshly mounted
  // chip (and its auto-grown reply field) is measured before we scroll.
  useEffect(() => {
    if (stagedQuotes.length > prevCountRef.current) {
      const el = scrollRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    }
    prevCountRef.current = stagedQuotes.length;
  }, [stagedQuotes.length]);

  if (stagedQuotes.length === 0) {
    return null;
  }

  return (
    <div ref={scrollRef} className="mb-2 max-h-[180px] overflow-y-auto touch-mobile:px-3">
      <div className="flex flex-col gap-1.5">
        {stagedQuotes.map((quote) => (
          <StagedQuoteChip key={quote.id} quote={quote} />
        ))}
      </div>
    </div>
  );
}
