/**
 * A tool call's risk level as a pill, with the tolerance sentence on hover.
 *
 * Levels that map to no tolerance tier (`workspace`, anything unrecognised)
 * carry no tooltip, because there is no sentence to show for them.
 */

import { Tooltip } from "@vellumai/design-library";

import { RiskBadge } from "@/domains/chat/components/risk-badge";
import { getRiskToleranceHint } from "@/domains/chat/utils/risk";

export function RiskChip({ level }: { level?: string }) {
  const hint = getRiskToleranceHint(level);
  if (!level) {
    return null;
  }
  if (!hint) {
    return <RiskBadge level={level} />;
  }
  return (
    <Tooltip content={hint}>
      {/* `Tooltip` mounts its trigger with Radix `asChild`, which needs a child
          that forwards the ref and spreads the props it is handed. `RiskBadge`
          accepts only its own three props, so the trigger has to be a real
          element wrapping it. Shipping this would be a good moment to let the
          badge forward the rest of its props instead. */}
      <span className="inline-flex">
        <RiskBadge level={level} />
      </span>
    </Tooltip>
  );
}
