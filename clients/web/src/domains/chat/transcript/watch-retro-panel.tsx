/**
 * One answerable section of a watch retrospective, lifted out of the prose.
 *
 * The section keeps the heading the model wrote and the lead-in it wrote under
 * it. What changes is that its bullets stop being bullets: each becomes a row
 * with somewhere to put an answer. That is the whole point of the treatment.
 * The list of things the recording left uncertain is the most correctable part
 * of the report and reads as hedging while it sits as bullet four of five, and
 * the alignment pass is a question that was rendered as a paragraph.
 *
 * The panel is a surface rather than a heading with an indent, because the
 * boundary is what says these lines are addressed to the reader while the rest
 * of the message is addressed about the session. The icon carries which kind
 * it is instead of a caption saying so.
 */

import { EyeOff, ListChecks } from "lucide-react";
import { type ReactNode } from "react";
import { Card, Typography } from "@vellumai/design-library";

import { WatchRetroPointRow } from "@/domains/chat/transcript/watch-retro-point-row";
import type { WatchRetroPointsSegment } from "@/domains/chat/transcript/watch-retro";

export interface WatchRetroPanelProps {
  segment: WatchRetroPointsSegment;
  /** The retrospective's message, so an answer is paired back to it. */
  messageId: string;
  /** Renders markdown, supplied by the transcript that owns the message. */
  renderMarkdown: (markdown: string) => ReactNode;
}

export function WatchRetroPanel({
  segment,
  messageId,
  renderMarkdown,
}: WatchRetroPanelProps) {
  const isGaps = segment.kind === "gaps";
  const Icon = isGaps ? EyeOff : ListChecks;

  return (
    <Card.Root
      bordered
      padding="sm"
      data-testid="watch-retro-panel"
      data-kind={segment.kind}
      className="my-3 bg-[var(--surface-lift)]"
    >
      <Card.Body padding="md" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Icon
            aria-hidden="true"
            className="size-4 shrink-0 text-[var(--content-tertiary)]"
          />
          <Typography
            variant="body-small-emphasised"
            as="h4"
            className="min-w-0 text-[color:var(--content-secondary)]"
          >
            {segment.heading}
          </Typography>
        </div>
        {segment.lead.length > 0 && renderMarkdown(segment.lead)}
        <ul className="flex list-none flex-col divide-y divide-[var(--border-base)] p-0">
          {segment.points.map((point, index) => (
            <WatchRetroPointRow
              // Points are the model's own wording and can repeat, so the
              // position is what identifies a row in the list.
              key={`${index}-${point}`}
              point={point}
              messageId={messageId}
              agreeable={!isGaps}
              renderMarkdown={renderMarkdown}
            />
          ))}
        </ul>
      </Card.Body>
    </Card.Root>
  );
}
