/**
 * PROPOSAL, not registered. See `tool-detail-proposals.stories.tsx`.
 *
 * The panel currently spends a full-width `Notice` bar and a section label on
 * one word plus a sentence about when that level auto-approves. This is the
 * same information as a pill, with the sentence on hover.
 *
 * `RiskBadge` is the pill the product already has: it matches the macOS
 * `RiskBadgeView` convention, has tests and stories, and today nothing renders
 * it. Levels with no tolerance tier (`workspace`, anything unrecognised) get no
 * tooltip, because there is no sentence to show.
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
      <RiskBadge level={level} />
    </Tooltip>
  );
}
