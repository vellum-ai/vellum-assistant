// Wraps one ACP chat block with a left timeline rail. The caller decides which
// blocks anchor the rail (showDot): action blocks and the first/last block get
// a dot; the narration in between passes showDot={false} and renders inline with
// only the connector running through. Same chrome as the subagent / workflow
// timelines (14px dot box, 5px `--content-disabled` dot, 1px `--border-element`
// connector at left-[6.5px]), adapted for variable-height chat blocks instead of
// fixed-height step rows.

import type { ReactNode } from "react";

export function AcpChatTimelineBlock({
  showDot,
  isLast,
  children,
}: {
  /** Action blocks (tool/plan) show the dot; narration passes false (rail only). */
  showDot: boolean;
  /** The final block draws no trailing connector. */
  isLast: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`relative flex items-start gap-2${isLast ? "" : " pb-4"}`}>
      {/* Connector trails down to the next dot. A dotted (action) block begins
          the line just below its dot (top-[16px]); a dotless narration block
          runs it full-height (top-0) so the rail stays continuous through the
          empty dot slot. Omitted on the last block. */}
      {!isLast && (
        <div
          aria-hidden
          className={`absolute bottom-0 left-[6.5px] w-px bg-[var(--border-element)] ${
            showDot ? "top-[16px]" : "top-0"
          }`}
        />
      )}
      {showDot ? (
        <span
          aria-hidden
          data-testid="acp-chat-timeline-dot"
          // No top margin so the 14px dot centers on the 14px icon-led first line.
          className="flex h-[14px] w-[14px] shrink-0 items-center justify-center"
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
