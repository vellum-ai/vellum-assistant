/**
 * One answered question's response row.
 *
 * The leading glyph distinguishes the three answer shapes at a glance and
 * mirrors the interactive card's iconography: a check for a chosen option, a
 * pencil for typed text, a skip arrow for a question left unanswered.
 */

import { Check, Pencil, SkipForward } from "lucide-react";

import type { ResolvedAnswer } from "@/domains/chat/answered-question";
import { Typography } from "@vellumai/design-library";

export interface AnsweredQuestionRowProps {
  item: ResolvedAnswer;
}

const GLYPH_BY_KIND = {
  option: Check,
  free_text: Pencil,
  skipped: SkipForward,
} as const;

export function AnsweredQuestionRow({ item }: AnsweredQuestionRowProps) {
  const Glyph = GLYPH_BY_KIND[item.kind];
  const isSkipped = item.kind === "skipped";
  const textColor = isSkipped
    ? "text-[color:var(--content-tertiary)]"
    : "text-[color:var(--content-default)]";

  return (
    <div className="flex items-start gap-2 rounded-md bg-[var(--surface-base)] px-3 py-2">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex shrink-0 items-center justify-center ${
          isSkipped
            ? "text-[color:var(--content-tertiary)]"
            : "text-[color:var(--primary-base)]"
        }`}
      >
        <Glyph className="h-3.5 w-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Typography
          variant="body-medium-default"
          as="span"
          className={textColor}
        >
          {item.answer}
        </Typography>
        {item.answerDescription && (
          <Typography
            variant="body-small-default"
            as="span"
            className="text-[color:var(--content-tertiary)]"
          >
            {item.answerDescription}
          </Typography>
        )}
      </span>
    </div>
  );
}
