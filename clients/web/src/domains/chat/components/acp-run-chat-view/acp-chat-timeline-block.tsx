// Wraps one ACP chat block with a left timeline rail. Blocks are grouped into
// phases (runs of the same kind): only the first block of a phase shows a dot,
// so a burst of tool calls reads as one phase instead of N events. Mid-phase
// blocks render just the connector. Matches the subagent / workflow phase
// timelines (same 14px dot box, 5px `--content-disabled` dot, 1px
// `--border-element` connector at left-[6.5px]), adapted for variable-height
// chat blocks instead of fixed-height step rows.

import type { ReactNode } from "react";

export function AcpChatTimelineBlock({
  showDot,
  isLast,
  children,
}: {
  /** First block of a phase shows the dot; mid-phase blocks show only the rail. */
  showDot: boolean;
  /** The final block draws no trailing connector. */
  isLast: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`relative flex items-start gap-2${isLast ? "" : " pb-4"}`}>
      {/* Connector trails down to the next block's dot. A phase-start block
          begins the line just below its dot (top-[18px]); a mid-phase block
          runs it full-height (top-0) so the rail stays continuous through the
          empty dot slot. Omitted on the last block. */}
      {!isLast && (
        <div
          aria-hidden
          className={`absolute bottom-0 left-[6.5px] w-px bg-[var(--border-element)] ${
            showDot ? "top-[18px]" : "top-0"
          }`}
        />
      )}
      {showDot ? (
        <span
          aria-hidden
          data-testid="acp-chat-timeline-dot"
          className="mt-[2px] flex h-[14px] w-[14px] shrink-0 items-center justify-center"
        >
          <span className="h-[5px] w-[5px] rounded-full bg-[var(--content-disabled)]" />
        </span>
      ) : (
        <span aria-hidden className="h-[14px] w-[14px] shrink-0" />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
