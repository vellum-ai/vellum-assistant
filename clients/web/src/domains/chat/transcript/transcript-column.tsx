/**
 * The transcript's centered column. Every row in the scroller (history rows,
 * the latest-turn cluster, and any surface the assistant sends) sits in one of
 * these, so they share a width and a set of horizontal insets down the whole
 * conversation.
 *
 * The `--chat-max-width` cap and the horizontal padding sit on the same
 * element, so the cap measures the content *plus* its gutters and each row is
 * inset from the composer's edge below it. `ChatColumn` (the footer stack)
 * deliberately does the opposite, which is why these are two components and
 * not one; see its docstring for that side.
 *
 * `contain: content` is layout *and paint* containment, so anything a row
 * hangs past its own edge is hard-clipped rather than overflowing visibly:
 * a reaction chip's corner overhang and the subagent row's Details label have
 * both had to reserve their space inside the row instead. Keep it here, and
 * keep stories mounting in this: a card whose chrome escapes the column is
 * meant to look broken, in Storybook exactly as it does in the app.
 */

import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/utils/misc";

interface TranscriptColumnProps {
  /** Per-row framing: the latest-edge region adds a flex column. */
  className?: string;
  /**
   * Pins the latest-edge region to the viewport height so its anchor user
   * message sits at the top. The only style a column ever varies, which is
   * why it is this prop and not a `style` passthrough.
   */
  minHeight?: CSSProperties["minHeight"];
  children: ReactNode;
}

export function TranscriptColumn({
  className,
  minHeight,
  children,
}: TranscriptColumnProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[var(--chat-max-width)] contain-content px-4 sm:px-6",
        className,
      )}
      style={minHeight === undefined ? undefined : { minHeight }}
    >
      {children}
    </div>
  );
}
