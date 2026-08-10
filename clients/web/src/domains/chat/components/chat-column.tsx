/**
 * The chat body's centered column: everything stacked below the transcript
 * (the composer and its notices, the docked starters, the below-fold block)
 * shares one width and one set of horizontal insets, so they line up with
 * each other down the whole footer.
 *
 * The horizontal padding sits on the outer element and the `--chat-max-width`
 * cap on an inner one, so the cap measures the content rather than the
 * content plus its gutters: at a wide viewport the column is exactly
 * `--chat-max-width`, and the padding only bites once the viewport is
 * narrower than that. The transcript column deliberately does the opposite
 * (`transcript.tsx` puts `px-4 sm:px-6` inside the capped box, insetting rows
 * from the composer's edge), which is why these are two components and not
 * one.
 *
 * Vertical padding is the caller's, through `className`: it is the only thing
 * that legitimately differs between the three stacks.
 */

import type { ReactNode } from "react";

interface ChatColumnProps {
  /** Vertical padding and any other per-stack framing. */
  className?: string;
  /**
   * Rendered inside the padded wrapper but outside the capped column, for
   * chrome that positions against the column's full padded width rather than
   * flowing in it (the refresh pill hangs above the composer this way). A
   * caller passing this must also pass `relative` in `className`: the
   * positioning context is not applied here, because adding one changes the
   * containing block for any absolutely-positioned descendant of `children`,
   * and `children` is a slot the column does not control.
   */
  overlay?: ReactNode;
  children: ReactNode;
}

export function ChatColumn({ className, overlay, children }: ChatColumnProps) {
  return (
    <div className={`px-3 sm:px-6${className ? ` ${className}` : ""}`}>
      {overlay}
      <div className="mx-auto max-w-[var(--chat-max-width)]">{children}</div>
    </div>
  );
}
