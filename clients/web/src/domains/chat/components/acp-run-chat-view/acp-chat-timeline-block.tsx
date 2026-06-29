// Wraps one ACP chat block with a left timeline rail — a small dot aligned to
// the block's first line plus a 1px connector running down to the next block's
// dot. Matches the subagent / workflow phase timelines (same 14px dot box, 5px
// `--content-disabled` dot, 1px `--border-element` connector at left-[6.5px]),
// adapted for variable-height chat blocks instead of fixed-height step rows.

import type { ReactNode } from "react";

export function AcpChatTimelineBlock({
  isLast,
  children,
}: {
  /** The final block draws no trailing connector. */
  isLast: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`relative flex items-start gap-2${isLast ? "" : " pb-4"}`}>
      {/* Connector trails from just below this dot to the next block's dot.
          Omitted on the last block. */}
      {!isLast && (
        <div
          aria-hidden
          className="absolute bottom-0 left-[6.5px] top-[18px] w-px bg-[var(--border-element)]"
        />
      )}
      <span
        aria-hidden
        data-testid="acp-chat-timeline-dot"
        className="mt-[2px] flex h-[14px] w-[14px] shrink-0 items-center justify-center"
      >
        <span className="h-[5px] w-[5px] rounded-full bg-[var(--content-disabled)]" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
