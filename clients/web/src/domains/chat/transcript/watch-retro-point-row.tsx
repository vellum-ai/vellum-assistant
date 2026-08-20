/**
 * One thing the watch retrospective wants an answer to, drawn as a row that
 * can be answered where it is read.
 *
 * The answer does not go anywhere new. Quote-reply already exists for exactly
 * this shape: the user marks a passage of the assistant's message, writes a
 * response to it, and the pair is staged above the composer until the next
 * send folds it in as a blockquote followed by the reply
 * (`quote-reply-store.ts`, `use-composer-submit.ts`). A retrospective's gaps
 * and alignment points are passages the assistant has already singled out, so
 * the row skips the text selection and stages the same pair directly. The
 * assistant then receives the answer attached to the point it answers, which
 * is what the alignment pass is asking for, and nothing about the send path,
 * the wire, or the daemon has to learn what a retrospective is.
 *
 * **The staged quote is the only record that an answer exists.** There is no
 * local answered flag: the row reads its own state out of the store, so
 * removing the chip above the composer un-answers the row, and sending clears
 * every row at once because the answers are now in the transcript. Two points
 * with byte-identical text share one row state, which is the price of keying
 * on the quotation itself and is worth it to keep a single owner.
 */

import { ArrowRight, Check, Pencil } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button, Input, Typography } from "@vellumai/design-library";

import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { useTranslation } from "@/i18n";

export interface WatchRetroPointRowProps {
  /** The point's own markdown, quoted verbatim when an answer is staged. */
  point: string;
  /** The retrospective's message, so the answer is paired back to it. */
  messageId: string;
  /**
   * Whether the point is something to agree with rather than only to fill in.
   * An alignment point states a reading the assistant wants confirmed, so
   * agreeing is a whole answer; a gap is a blank, and a one-tap "yes" would
   * mean nothing against it.
   */
  agreeable: boolean;
  /** Renders the point's inline markdown, supplied by the transcript. */
  renderMarkdown: (markdown: string) => ReactNode;
}

export function WatchRetroPointRow({
  point,
  messageId,
  agreeable,
  renderMarkdown,
}: WatchRetroPointRowProps) {
  const { t } = useTranslation("chat");
  const staged = useQuoteReplyStore((state) =>
    state.stagedQuotes.find(
      (quote) =>
        quote.sourceMessageId === messageId && quote.quotedText === point,
    ),
  );
  const addStagedQuote = useQuoteReplyStore.use.addStagedQuote();
  const removeStagedQuote = useQuoteReplyStore.use.removeStagedQuote();
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const stage = useCallback(
    (replyText: string) => {
      addStagedQuote({
        quotedText: point,
        replyText,
        sourceMessageId: messageId,
      });
      setDraft(null);
    },
    [addStagedQuote, messageId, point],
  );

  const openDraft = useCallback(() => {
    setDraft("");
    // The field mounts in the same commit, so focus has to wait for it.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const commitDraft = useCallback(() => {
    const trimmed = (draft ?? "").trim();
    if (trimmed.length === 0) {
      return;
    }
    stage(trimmed);
  }, [draft, stage]);

  return (
    <li className="flex items-start gap-2 py-1.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {renderMarkdown(point)}
        {staged && staged.replyText.length > 0 && (
          <Typography
            variant="body-small-lighter"
            as="p"
            className="text-[color:var(--content-tertiary)]"
          >
            {staged.replyText}
          </Typography>
        )}
        {draft !== null && (
          <div className="flex items-center gap-1">
            <Input
              ref={inputRef}
              value={draft}
              fullWidth
              aria-label={t("watchRetro.answerField")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitDraft();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(null);
                }
              }}
            />
            <Button
              variant="primary"
              size="compact"
              iconOnly={<ArrowRight />}
              expandOnMobile={false}
              disabled={draft.trim().length === 0}
              onClick={commitDraft}
              aria-label={t("watchRetro.addToChat")}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {staged ? (
          <Button
            variant="ghost"
            size="compact"
            iconOnly={
              <Check className="text-[var(--system-positive-strong)]" />
            }
            expandOnMobile={false}
            onClick={() => removeStagedQuote(staged.id)}
            aria-label={t("watchRetro.undo")}
          />
        ) : (
          <>
            {agreeable && (
              <Button
                variant="outlined"
                size="compact"
                onClick={() => stage(t("watchRetro.agree"))}
              >
                {t("watchRetro.agree")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<Pencil />}
              expandOnMobile={false}
              onClick={openDraft}
              aria-label={t("watchRetro.answer")}
            />
          </>
        )}
      </div>
    </li>
  );
}
