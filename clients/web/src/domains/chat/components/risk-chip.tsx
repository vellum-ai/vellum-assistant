/**
 * A tool call's risk level as a pill, with the tolerance sentence alongside it.
 *
 * Where the pointer can hover, the sentence is the pill's tooltip and the
 * trigger takes focus so a keyboard reaches it too. Where it cannot, the shared
 * `Tooltip` mounts nothing at all by design, so the sentence renders as text
 * instead: on a touch client it is the only way to read it.
 *
 * Levels that map to no tolerance tier (`workspace`, anything unrecognised)
 * have no sentence to show.
 */

import { Tooltip, Typography } from "@vellumai/design-library";

import { RiskBadge } from "@/domains/chat/components/risk-badge";
import { getRiskToleranceHint } from "@/domains/chat/utils/risk";
import { usePointerCoarse } from "@/utils/pointer";

export function RiskChip({ level }: { level?: string }) {
  const hint = getRiskToleranceHint(level);
  const coarsePointer = usePointerCoarse();

  if (!level) {
    return null;
  }
  if (!hint) {
    return <RiskBadge level={level} />;
  }
  if (coarsePointer) {
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
          focusable so the tooltip opens on keyboard focus as well as hover. */}
      <span
        tabIndex={0}
        className="inline-flex rounded-[100px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-active)]"
      >
        <RiskBadge level={level} />
      </span>
    </Tooltip>
  );
}
