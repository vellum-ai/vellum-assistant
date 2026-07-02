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
  Button,
  Card,
  cn,
  Typography,
  quoteBlockquoteClassName,
} from "@vellumai/design-library";

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
            className={cn(quoteBlockquoteClassName, "mb-0")}
          >
            {truncate(quote.quotedText, 80)}
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

  if (stagedQuotes.length === 0) {
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
