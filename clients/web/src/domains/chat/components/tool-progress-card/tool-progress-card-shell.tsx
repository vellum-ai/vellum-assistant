
import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState, type ReactNode } from "react";

import { Button, Typography } from "@vellumai/design-library";

import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";

/**
 * Visual state that drives the shell's leading status indicator.
 *
 * - `loading`  → NO leading icon; the header title itself carries the
 *   in-flight signal via the avatar-tinted `StreamingShimmerText` sweep
 * - `complete` → green `CheckCircle2`
 * - `warning`  → amber `AlertTriangle` (a PARTIAL failure — some steps failed
 *   but not all, so the run still produced useful work)
 * - `denied`   → red `AlertCircle` (a request was blocked / denied)
 * - `error`    → red `AlertCircle` (the tool itself errored / EVERY step failed)
 *
 * `denied` and `error` render the same icon today and are kept distinct so
 * the two semantics can diverge visually later without a prop break.
 */
export type ToolProgressCardState =
  | "loading"
  | "complete"
  | "warning"
  | "denied"
  | "error";

export interface ToolProgressCardShellProps {
  /**
   * Drives the leading status indicator. See `ToolProgressCardState` for
   * the per-value chrome.
   */
  state: ToolProgressCardState;
  /**
   * Optional icon rendered between the three-dot status indicator and the
   * title — used by non-web-search consumers to show e.g. a tool-specific
   * glyph. Omitted by default so the existing web-search card keeps its
   * indicator-then-title layout.
   */
  leadingIcon?: ReactNode;
  /**
   * Per-step headline label rendered in the collapsed header. Animates via
   * the header carousel as new steps stream in.
   */
  currentStepTitle: string;
  /**
   * Secondary descriptor rendered to the right of the title in the
   * collapsed header. Accepts a string (truncated muted text) or any
   * `ReactNode` (e.g. a `<WebsiteCarousel />`). Consumers passing a node
   * should memoize it so the throttle hook doesn't fire on every parent
   * render.
   */
  currentStepInfo: ReactNode;
  /**
   * Optional stable identity for the header carousel's enter/exit animation.
   * When supplied, the carousel keys its transition on this instead of the
   * title text, so a header whose only changing part is a live value (e.g. a
   * ticking "Working for 8s") updates in place rather than re-sliding on every
   * change. See {@link HeaderStepCarousel}'s `animationKey`.
   */
  headerAnimationKey?: string;
  /**
   * When `true`, the leading status indicator is omitted from the header even
   * for terminal states. The `loading` state never renders an indicator —
   * the shimmering title is the in-flight signal — so this only affects the
   * terminal check / alert icons.
   */
  hideStatusIndicator?: boolean;
  /**
   * Paints the header with the persistent active surface (the same treatment
   * as hover) — used when the panel this header opens (e.g. the activity
   * steps drawer) is currently showing this group, so the header reads as
   * the selected/open affordance. Bare layout only.
   */
  headerActive?: boolean;
  /** Pre-formatted step count for the toggle pill, e.g. "2 steps". */
  stepCount: string;
  /** Whether the card starts expanded. Uncontrolled by default. */
  defaultExpanded?: boolean;
  /**
   * Opt-in "bare" variant. When `true`, the shell drops its boxed card chrome
   * (rounded surface, border, base background) and the inner divider so the
   * header + expanded body render INLINE on the chat background — matching the
   * lone `SingleActivity` link language
   * with a subtle ghost hover on the header row instead of a container.
   *
   * Only the default (no-`headerActionSlot`) header layout participates in
   * bare mode — the action-slot branch (subagent inline card) never passes
   * `bare` and keeps its container. Defaults to `false` so the web-search and
   * subagent cards are unaffected.
   */
  bare?: boolean;
  /** Controlled expanded value. Pairs with `onExpandChange`. */
  expanded?: boolean;
  /** Notified when the user toggles the expand/collapse button. */
  onExpandChange?: (next: boolean) => void;
  /**
   * When `true`, the header button is non-interactive — used when the card
   * has nothing to expand into (e.g. a 0-step card). The chrome stays the
   * same so the visual rhythm matches; only the toggle is disabled.
   */
  disableExpand?: boolean;
  /**
   * The expanded body. Rendered inside the height-animated region beneath
   * the header. Consumers own the spacing inside (the shell only adds the
   * divider above and the rounded-bottom-corner clipping). Omit for headers
   * with no in-place body (e.g. the unified activity header, which opens its
   * steps in the side panel instead).
   */
  children?: ReactNode;
  /**
   * `data-testid` for the outer card wrapper. Defaults to
   * `tool-progress-card-shell`.
   */
  "data-testid"?: string;
  /**
   * `data-testid` for the leading status indicator (three-dot dots or the
   * status icon). Defaults to `tool-progress-card-status-indicator`;
   * consumers override to preserve existing integration-test hooks.
   */
  statusIndicatorTestId?: string;
  /**
   * Optional action cluster rendered inside the header flex row, immediately
   * BEFORE the step-count pill. Used by inline-card variants (e.g. the
   * subagent inline card) to slot stop / open buttons into the header
   * without absolute-positioning over the shell's chrome. The slot is
   * rendered outside the surrounding `<Button>` so its interactive children
   * don't toggle the card's expand/collapse state — callers are responsible
   * for `stopPropagation()` on their own click handlers when needed.
   */
  headerActionSlot?: ReactNode;
  /**
   * When provided, replaces the default expand/collapse click behaviour on
   * the header button — the whole header row fires `onHeaderClick` instead
   * of toggling the expanded state. Used by the subagent inline card so
   * clicking anywhere on the row opens the subagent panel rather than
   * expanding an inline timeline. The button stays enabled regardless of
   * `disableExpand` when this is set.
   *
   * If both `onHeaderClick` and the toggle are needed (e.g. open AND
   * expand), the caller can compose by calling `onExpandChange` from inside
   * the override.
   */
  onHeaderClick?: () => void;
  /**
   * Accessible label for the header button. Defaults to a description of
   * the expand/collapse action — consumers that override `onHeaderClick`
   * should pass a label that matches the new action (e.g. "Open subagent").
   */
  headerAriaLabel?: string;
}

function StatusIndicator({
  state,
  testId,
}: {
  state: ToolProgressCardState;
  testId: string;
}) {
  switch (state) {
    case "loading":
      // Loading carries no leading icon — the shimmering header title is the
      // in-flight signal (the caller also skips rendering this slot).
      return null;
    case "complete":
      return (
        <CheckCircle2
          data-testid={testId}
          aria-hidden="true"
          data-state="complete"
          className="h-[14px] w-[14px] shrink-0 text-[var(--system-positive-strong)]"
        />
      );
    case "warning":
      return (
        <AlertTriangle
          data-testid={testId}
          aria-hidden="true"
          data-state="warning"
          className="h-[14px] w-[14px] shrink-0 text-[var(--system-mid-strong)]"
        />
      );
    case "denied":
    case "error":
    default:
      return (
        <AlertCircle
          data-testid={testId}
          aria-hidden="true"
          data-state={state}
          className="h-[14px] w-[14px] shrink-0 text-[var(--system-negative-strong)]"
        />
      );
  }
}

/**
 * Reusable rounded-card shell for tool-call progress cards.
 *
 * Owns the visual chrome shared across every tool's progress card — the
 * rounded surface, the leading status indicator (three-dot for loading,
 * check / alert icon for terminal states), an optional leading icon slot,
 * the animated `HeaderStepCarousel`, the "N step(s)" pill, and the
 * height-animated expanded body region. Consumers supply the per-step
 * content via `children`.
 *
 * Shared shell so non-web tool cards and subagent progress cards can
 * adopt the same visual language without
 * duplicating the rounded container, expand/collapse animation, and
 * `prefers-reduced-motion` handling.
 */
export function ToolProgressCardShell({
  state,
  leadingIcon,
  currentStepTitle,
  currentStepInfo,
  headerAnimationKey,
  hideStatusIndicator = false,
  headerActive = false,
  stepCount,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandChange,
  disableExpand = false,
  bare = false,
  children,
  "data-testid": dataTestId = "tool-progress-card-shell",
  statusIndicatorTestId = "tool-progress-card-status-indicator",
  headerActionSlot,
  onHeaderClick,
  headerAriaLabel,
}: ToolProgressCardShellProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] =
    useState(defaultExpanded);
  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : uncontrolledExpanded;
  const reduce = useReducedMotion();

  const handleToggle = () => {
    if (onHeaderClick) {
      onHeaderClick();
      return;
    }
    if (disableExpand) return;
    const next = !expanded;
    if (!isControlled) {
      setUncontrolledExpanded(next);
    }
    onExpandChange?.(next);
  };

  const transition = reduce
    ? { duration: 0 }
    : {
        duration: 0.25,
        ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
      };

  return (
    // Hover ownership lives on the inner Button. Padding ownership lives on
    // the inner Button (header) and the body section (when expanded) — the
    // outer wrapper provides only the card chrome (border, radius, base bg)
    // and no padding of its own. The Button's `rounded-*` is conditional so
    // its hover bg paints into the correct corners without clipping its
    // focus ring (overflow:hidden on the wrapper would clip the ring):
    //   - Collapsed: the Button IS the whole card content → fully rounded.
    //   - Expanded: the Button is just the header → rounded only on top so
    //     the divider + body section flow flush below.
    <div
      data-testid={dataTestId}
      className={
        bare
          ? "flex w-full flex-col"
          : "flex w-full flex-col rounded-[var(--radius-lg)] border-b border-[var(--border-base)] bg-[var(--surface-overlay)]"
      }
    >
      {/* The label cluster (dots, leading icon, carousel) is the toggle —
          clicking it expands / collapses (or fires `onHeaderClick`). The
          shared title cluster and step-count pill below are rendered in one of
          two header layouts depending on whether an action slot is present. */}
      {(() => {
        // Bare mode hugs its content (the pill sits right after the label,
        // per the left-aligned inline header); boxed mode keeps the
        // full-width `flex-1` cluster with the pill pushed to the right edge.
        const titleCluster = (
          <span
            className={
              bare
                ? "flex min-w-0 items-center gap-1"
                : "flex min-w-0 flex-1 items-center gap-1"
            }
          >
            {/* Loading renders no leading indicator at all — the shimmering
                title carries the in-flight signal — so the empty slot doesn't
                add a phantom gap before the label. */}
            {hideStatusIndicator || state === "loading" ? null : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={state}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { duration: 0.15, ease: [0.16, 1, 0.3, 1] }
                  }
                  className="inline-flex shrink-0"
                >
                  <StatusIndicator
                    state={state}
                    testId={statusIndicatorTestId}
                  />
                </motion.span>
              </AnimatePresence>
            )}
            {leadingIcon ? (
              // `mx-1` adds 4px on each side on top of the parent's `gap-1`
              // (also 4px) so the icon sits with ~8px of breathing room on
              // both sides — symmetric with the spacing between it and the
              // header text on its right.
              <span className="mx-1 flex shrink-0 items-center">
                {leadingIcon}
              </span>
            ) : null}
            <HeaderStepCarousel
              currentStepTitle={currentStepTitle}
              currentStepInfo={currentStepInfo}
              animationKey={headerAnimationKey}
              // Terminal states (complete / denied / error) flush the header
              // throttle so the final `(title, info)` lands in sync with the
              // status-icon swap. Without this, the 400ms min-dwell could
              // leave stale loading-state header text on-screen for up to
              // 400ms after the green check appears.
              bypassDwell={state !== "loading"}
              // While loading, the primary header label renders through the
              // avatar-tinted shimmer — it IS the loading indicator.
              shimmer={state === "loading"}
            />
          </span>
        );

        // Hide the pill when there is nothing useful to summarise — a literal
        // "0 steps" reads as broken state, and a "1 step" pill is just noise
        // next to the carousel title that already describes the single step.
        // Show the pill only at 2+ steps.
        const stepCountPill =
          stepCount &&
          !stepCount.startsWith("0 ") &&
          !stepCount.startsWith("1 ") ? (
            <span
              data-testid="tool-progress-card-step-count-pill"
              className="flex shrink-0 items-center rounded-[var(--radius-pill)] bg-[var(--surface-overlay)] px-[6px] py-[4px]"
            >
              <Typography
                variant="body-small-default"
                className="text-[var(--content-emphasised)]"
              >
                {stepCount}
              </Typography>
            </span>
          ) : null;

        // When `onHeaderClick` overrides the default toggle, the button is
        // always enabled — `disableExpand` only suppresses the expand path,
        // not external click handlers.
        const toggleProps = {
          variant: "ghost" as const,
          size: "compact" as const,
          "aria-expanded": onHeaderClick ? undefined : expanded,
          "aria-label":
            headerAriaLabel ?? (expanded ? "Collapse steps" : "Expand steps"),
          onClick: handleToggle,
          disabled: !onHeaderClick && disableExpand,
        };

        // Action-slot layout: the toggle button holds only the title cluster
        // (flex-1), and the action slot + step-count pill share a right-aligned
        // flex container with an 8px (`gap-2`) gap. The slot lives OUTSIDE the
        // toggle <Button> (nested <button>s are invalid HTML) as a real flex
        // sibling rather than an absolutely-positioned overlay, so the stop
        // button and pill align to the right end without fragile pixel offsets.
        if (headerActionSlot) {
          return (
            <div className="flex w-full items-center">
              <Button
                {...toggleProps}
                className={`h-auto min-w-0 flex-1 justify-start gap-2 p-3 ${
                  expanded
                    ? "rounded-tl-[var(--radius-lg)] rounded-b-none"
                    : "rounded-l-[var(--radius-lg)]"
                }`}
              >
                {titleCluster}
              </Button>
              <div
                data-testid="tool-progress-card-action-slot"
                className="flex shrink-0 items-center gap-2 pr-3"
              >
                {headerActionSlot}
                {stepCountPill}
              </div>
            </div>
          );
        }

        // Default layout: the whole row is the toggle, with the pill rendered
        // inside it after the label cluster.
        //
        // - Default (boxed): full-width card padding `p-3`, pill pushed to the
        //   right edge, and conditional card rounding so the ghost hover
        //   paints into the right corners.
        // - Bare: a lighter inline style that HUGS its content — the label
        //   cluster and the step-count pill sit together on the left rather
        //   than spanning the row — so the header reads like the inline
        //   `SingleActivity` links around it.
        return (
          <Button
            {...toggleProps}
            className={
              bare
                ? // Flush-left to match the inline `SingleActivity` link
                  // (which uses `-mx-1.5 px-1.5`): pull the
                  // header 6px left, and cap the width at container + 6px so
                  // a long label still truncates instead of overflowing.
                  // `hover:bg-[var(--surface-hover)]` overrides the ghost
                  // Button's default `--surface-active` hover so the header
                  // shares the exact same translucent surface-hover as the
                  // inline `SingleActivity` (consistent across light/dark).
                  // While this header's panel is open (`headerActive`) or its
                  // body is expanded, that same surface-hover stays painted so
                  // the header reads as the active/open affordance.
                  `h-auto w-fit min-w-0 max-w-[calc(100%+0.375rem)] justify-start gap-2 rounded-md px-1.5 py-1.5 -ml-1.5 hover:bg-[var(--surface-hover)]${
                    expanded || headerActive
                      ? " bg-[var(--surface-hover)]"
                      : ""
                  }`
                : `h-auto w-full min-w-0 justify-between gap-2 p-3 ${
                    expanded
                      ? "rounded-t-[var(--radius-lg)] rounded-b-none"
                      : "rounded-[var(--radius-lg)]"
                  }`
            }
          >
            {titleCluster}
            {stepCountPill}
          </Button>
        );
      })()}

      {/* Expanded body — divider + children. Animated height-collapse honors
          prefers-reduced-motion (snap when reduced via 0-duration transition). */}
      <AnimatePresence initial={false}>
        {expanded && children != null ? (
          <motion.div
            key="expanded-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2">
              {/* Boxed mode draws a separator between the header and the body;
                  bare mode flows inline with no divider line. */}
              {bare ? null : (
                <div className="h-px w-full bg-[var(--surface-base)]" />
              )}
              {children}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";
export { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
