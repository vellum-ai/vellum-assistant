/**
 * Renders the list of staged quote-replies above the composer. Each chip
 * shows a truncated preview of the quoted text and an editable reply field
 * (kept in sync with the store so replies can be revised after staging),
 * with an X button to remove it.
 *
 * The strip is scrollable (capped so it never dominates the viewport) and
 * wrapped in a {@link ScrollShadow} that fades its top/bottom edges. Chips
 * animate in and out, and the strip stays pinned to the newest chip as it
 * grows, so an addition never jolts the layout or lands below the fold.
 */

import { MessageSquareQuote, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import {
  Button,
  Card,
  ScrollShadow,
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
      <Card.Body padding="md" className="flex items-start gap-2.5">
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
          <textarea
            ref={replyRef}
            value={quote.replyText}
            onChange={(e) =>
              updateStagedQuoteReply(quote.id, e.target.value)
            }
            rows={1}
            placeholder="Type your reply…"
            aria-label="Edit reply"
            className="mt-1.5 w-full resize-none overflow-hidden border-none bg-transparent p-0 text-body-small-default text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:outline-none"
          />
        </div>
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          expandOnMobile={false}
          onClick={() => removeStagedQuote(quote.id)}
          className="shrink-0 self-center opacity-0 transition-opacity group-hover/quote:opacity-100 focus-visible:opacity-100"
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
  const reduceMotion = useReducedMotion();

  // When a quote is added, keep the strip pinned to the newest chip while its
  // insert animation grows it — so the addition never lands silently below the
  // fold. Pinning across a few frames tracks the growing height smoothly.
  useEffect(() => {
    if (stagedQuotes.length > prevCountRef.current) {
      const el = scrollRef.current;
      if (el) {
        let frames = 0;
        let rafId = 0;
        const pin = () => {
          el.scrollTop = el.scrollHeight;
          if (frames++ < 20) {
            rafId = requestAnimationFrame(pin);
          }
        };
        rafId = requestAnimationFrame(pin);
        prevCountRef.current = stagedQuotes.length;
        // Cancel on unmount / re-trigger so the chain never writes to a
        // detached element or overlaps a second run for rapid additions.
        return () => cancelAnimationFrame(rafId);
      }
    }
    prevCountRef.current = stagedQuotes.length;
  }, [stagedQuotes.length]);

  if (stagedQuotes.length === 0) {
    return null;
  }

  return (
    <ScrollShadow
      ref={scrollRef}
      orientation="vertical"
      size={20}
      hideScrollBar
      className="mb-2 max-h-[140px]"
    >
      <div className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {stagedQuotes.map((quote) => (
            <motion.div
              key={quote.id}
              layout
              initial={
                reduceMotion
                  ? false
                  : { opacity: 0, height: 0, scale: 0.98 }
              }
              animate={{ opacity: 1, height: "auto", scale: 1 }}
              exit={
                reduceMotion
                  ? { opacity: 0 }
                  : { opacity: 0, height: 0, scale: 0.98 }
              }
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <StagedQuoteChip quote={quote} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ScrollShadow>
  );
}
