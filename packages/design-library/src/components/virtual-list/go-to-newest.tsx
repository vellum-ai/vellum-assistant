import { ChevronDown } from "lucide-react";

import { cn } from "../../utils/cn";

/**
 * Composable "Go to Newest" affordance for a {@link VirtualList}.
 *
 * Consumers position it absolutely over a list (typically bottom-center,
 * above a composer) and wire `visible`/`onClick` to their scroll
 * coordinator — pair it with `VirtualList`'s `atBottomStateChange` callback
 * and `scrollToBottom()` handle method.
 *
 * Visibility is driven by the `visible` prop rather than conditional
 * mounting so the pill can fade in and out: when hidden it fades to
 * `opacity-0`, stops capturing pointer events, and drops out of the tab
 * order. When `isStreaming` is true a three-dot pulse renders at the start
 * of the pill to signal that more content is still arriving out of view; the
 * pulse is gated behind `motion-safe` so it honours `prefers-reduced-motion`.
 */
export interface GoToNewestProps {
  /** Whether the pill is shown. Fades out when false. */
  visible: boolean;
  /** Invoked when the pill is clicked. */
  onClick: () => void;
  /** Show animated streaming dots. */
  isStreaming?: boolean;
  className?: string;
}

/**
 * Per-dot animation delays (seconds). Negative offsets stagger the three
 * dots into the pulse cycle so they read as a travelling wave on mount
 * rather than pulsing in unison.
 */
const STREAMING_DOT_DELAYS = [-0.333, 0, -0.667] as const;

export function GoToNewest({
  visible,
  onClick,
  isStreaming = false,
  className,
}: GoToNewestProps) {
  return (
    <button
      type="button"
      data-slot="go-to-newest"
      onClick={onClick}
      aria-label="Go to newest"
      aria-hidden={!visible}
      tabIndex={visible ? undefined : -1}
      className={cn(
        "pointer-events-auto inline-flex items-center gap-1 rounded-full px-3 py-2",
        "cursor-pointer shadow-md transition-opacity duration-150",
        "bg-[var(--surface-lift)] text-body-medium-default text-[color:var(--content-emphasised)]",
        !visible && "pointer-events-none opacity-0",
        className,
      )}
    >
      {isStreaming ? (
        <span aria-hidden className="inline-flex items-center gap-[3px]">
          {STREAMING_DOT_DELAYS.map((delay, i) => (
            <span
              key={i}
              className="block h-2 w-2 rounded-full bg-[var(--content-tertiary)] motion-safe:animate-go-to-newest-dot"
              style={{ animationDelay: `${delay}s` }}
            />
          ))}
        </span>
      ) : null}
      Go to Newest
      <ChevronDown className="h-3 w-3" />
    </button>
  );
}
