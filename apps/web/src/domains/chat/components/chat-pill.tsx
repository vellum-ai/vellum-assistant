import clsx from "clsx";
import { type ReactNode } from "react";

/**
 * Shared chrome for chat-overlay pills (small floating affordances
 * rendered above the composer in the chat view). Currently consumed
 * by `ScrollToLatestButton` and `RefreshFeedbackPill` so both share
 * a single visual language: lifted surface, rounded-full capsule,
 * label-sized text, soft drop shadow.
 *
 * Renders as a `<button>` when `onClick` is provided, otherwise as a
 * non-interactive `<div>` with the role/aria-live the caller chooses
 * (e.g. `role="status"` for a polite announcement).
 *
 * The `tone` prop swaps the surface palette — "default" is the lifted
 * neutral surface, "negative" is the error-wash variant used by the
 * refresh-feedback error case.
 */
export type ChatPillTone = "default" | "negative";

/**
 * "compact" — 12 px label, py-1.5. Original size, used by
 * `RefreshFeedbackPill`.
 * "regular" — 14 px body-medium, py-2. Matches the Figma "Go to Newest"
 * pill spec at node 5010:103945.
 */
export type ChatPillSize = "compact" | "regular";

interface ChatPillProps {
  children: ReactNode;
  /** Visual tone. Defaults to "default" (lifted neutral surface). */
  tone?: ChatPillTone;
  /** Visual size. Defaults to "compact". */
  size?: ChatPillSize;
  /** When provided, the pill renders as a button with this handler. */
  onClick?: () => void;
  /** Accessible label. Required when `onClick` is set. */
  ariaLabel?: string;
  /** Role for the non-interactive case (e.g. "status"). Ignored when
   *  `onClick` is set. */
  role?: string;
  /** aria-live for the non-interactive case. Ignored when `onClick`
   *  is set. */
  ariaLive?: "polite" | "assertive" | "off";
  /** Extra className appended to the chrome — use sparingly. */
  className?: string;
}

const BASE_CHROME =
  "pointer-events-auto inline-flex items-center gap-1 rounded-full shadow-md";

const SIZE_CLASSES: Record<ChatPillSize, string> = {
  compact: "px-3 py-1.5 text-label-small-default",
  regular: "px-3 py-2 text-body-medium-default",
};

const TONE_CLASSES: Record<ChatPillTone, string> = {
  default: "bg-[var(--surface-lift)] text-[var(--content-secondary)]",
  negative:
    "border border-[var(--system-negative-strong)] bg-[var(--system-negative-weak)] text-[var(--content-default)]",
};

export function ChatPill({
  children,
  tone = "default",
  size = "compact",
  onClick,
  ariaLabel,
  role,
  ariaLive,
  className,
}: ChatPillProps) {
  const merged = clsx(
    BASE_CHROME,
    SIZE_CLASSES[size],
    TONE_CLASSES[tone],
    className,
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className={clsx(merged, "cursor-pointer")}
      >
        {children}
      </button>
    );
  }

  return (
    <div role={role} aria-live={ariaLive} className={merged}>
      {children}
    </div>
  );
}
