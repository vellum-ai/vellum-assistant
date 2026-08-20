/**
 * A watch retrospective as the transcript draws it: the report left as prose,
 * and the two parts that are questions turned into things that can be
 * answered.
 *
 * The message is not replaced by a widget. Sections the parser did not
 * recognize come back through `renderMarkdown` in their original order and
 * their original wording, so a report the model phrased differently loses
 * nothing and only the parts that were understood are redrawn. See
 * `watch-retro.ts` for why recognition works that way.
 *
 * Markdown rendering is injected rather than imported, because the transcript
 * owns a long list of per-message concerns the markdown renderer needs
 * (attachments, credential chips, workspace path links, the assistant the row
 * belongs to). Taking a callback keeps all of that at the one call site that
 * already has it.
 */

import { Fragment, type ReactNode } from "react";

import { WatchRetroPanel } from "@/domains/chat/transcript/watch-retro-panel";
import type { WatchRetroSegment } from "@/domains/chat/transcript/watch-retro";

export interface WatchRetroCardProps {
  segments: readonly WatchRetroSegment[];
  /** The retrospective's message, so an answer is paired back to it. */
  messageId: string;
  renderMarkdown: (markdown: string) => ReactNode;
}

export function WatchRetroCard({
  segments,
  messageId,
  renderMarkdown,
}: WatchRetroCardProps) {
  return (
    <div data-slot="watch-retro">
      {segments.map((segment, index) => {
        const key = `watch-retro-${index}`;
        if (segment.kind === "markdown") {
          return <Fragment key={key}>{renderMarkdown(segment.text)}</Fragment>;
        }
        return (
          <WatchRetroPanel
            key={key}
            segment={segment}
            messageId={messageId}
            renderMarkdown={renderMarkdown}
          />
        );
      })}
    </div>
  );
}
