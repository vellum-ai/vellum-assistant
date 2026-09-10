/**
 * A tool call's risk level as a pill, with the tolerance sentence alongside it.
 *
 * Where the device can hover, the sentence is the pill's tooltip and the trigger
 * takes focus so a keyboard reaches it too. Where it cannot, the shared
 * `Tooltip` mounts nothing at all by design, so the sentence renders as text
 * instead: there it is the only way to read it.
 *
 * The branch reads `useHoverCapable`, the same signal `Tooltip` gates itself on.
 * Hover and pointer are independent media features, so asking about pointer
 * coarseness instead would disagree with the tooltip on a stylus device, which
 * reports `hover: none` with `pointer: fine`: this would pick the tooltip and
 * the tooltip would render nothing, losing the sentence exactly where the
 * fallback exists to keep it.
 *
 * Levels that map to no tolerance tier (`workspace`, anything unrecognised)
 * have no sentence to show.
 */

import { Tooltip, Typography } from "@vellumai/design-library";

import { RiskBadge } from "@/domains/chat/components/risk-badge";
import { getRiskToleranceHint } from "@/domains/chat/utils/risk";
import { useHoverCapable } from "@/hooks/use-hover-affordance";

export function RiskChip({ level }: { level?: string }) {
  const hint = getRiskToleranceHint(level);
  const hoverCapable = useHoverCapable();

  if (!level) {
    return null;
  }
  if (!hint) {
    return <RiskBadge level={level} />;
  }
  if (!hoverCapable) {
    return (
      <>
        <RiskBadge level={level} />
        <Typography
          variant="body-small-lighter"
          as="span"
          className="min-w-0 text-[var(--content-tertiary)]"
        >
          {hint}
        </Typography>
      </>
    );
  }
  return (
    <Tooltip content={hint}>
      {/* `Tooltip` mounts its trigger with Radix `asChild`, which needs a child
          that forwards the ref and spreads the props it is handed, and
          `RiskBadge` accepts only its own three. `tabIndex` makes the wrapper
          focusable so the tooltip opens on keyboard focus as well as hover.
          `cursor-help` because the pill is neither a button nor prose: without
          it the wrapper inherits `auto`, which over text is the I-beam, so a
          chip carrying an explanation looked like a text selection. It matches
          the design library's own tooltip example and the plugins picker.
          `select-none` for the same reason: a pill is a label, not a sentence
          to drag across. */}
      <span
        tabIndex={0}
        className="inline-flex cursor-help rounded-[100px] select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-active)]"
      >
        <RiskBadge level={level} />
      </span>
    </Tooltip>
  );
}
